// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AttStatus, Evaluation, Level, Phase, Position, State} from "./libraries/Types.sol";
import {CollateralRegistry} from "./CollateralRegistry.sol";
import {MarketOracle} from "./MarketOracle.sol";
import {LiquidityPool} from "./LiquidityPool.sol";
import {CreditFacility} from "./CreditFacility.sol";
import {FacilityFactory} from "./FacilityFactory.sol";

/// @title RiskManager
/// @notice Policy, the two-signal risk engine, the facility state machine, and permissionless forced reduction.
///
/// Borrowed USDG never leaves the facility, so the brokerage collateral only has to cover what the facility
/// could lose, not the face value of the loan:
///
///   stressed assets = idle USDG + sum(holding * mark * (1 - session haircut))
///   exposure        = max(0, debt - stressed assets)
///
/// Signals (1e18 = 100%):
///   U = exposure / creditLimit   creditLimit comes from the broker's attested shares, marked session-aware
///   H = assets / debt            how much of the borrowed USDG the facility can still cover at mark
///
/// New risk (borrow, buy) must leave U <= maxBorrowUtilBps (initial margin). The levels above it are maintenance.
///
/// Every state-increasing action re-evaluates from scratch, so a revocation or a weekend crash takes effect
/// in the same block without any keeper. `poke` only persists timers and emits events.
contract RiskManager is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant BPS_TO_WAD = 1e14;
    uint256 public constant MAX_TRADE_TOKENS = 16;

    struct Params {
        uint16 maxLtvBps;
        uint16 maxBorrowUtilBps; // post-borrow U cap
        uint16 uWarnBps;
        uint16 uCallBps;
        uint16 uDelevBps;
        uint16 hWarnBps;
        uint16 hCallBps;
        uint16 hDelevBps;
        uint16 hysteresisBps;
        uint16 maxSlippageBps;
        uint16 keeperTipBps;
        uint16 maxPerTokenBps;
        uint32 cureWindow;
        uint32 freezeGrace;
        uint32 defaultGrace;
        uint256 maxKeeperTip; // base asset units
        uint256 maxCreditPerFacility; // USD, 1e18
        uint256 maxPositionUsd; // USD, 1e18
    }

    struct Record {
        Phase phase;
        Level level; // persisted for hysteresis
        State lastState; // for StateChanged events
        uint64 frozenAt;
        uint64 cureStartedAt;
    }

    CollateralRegistry public immutable registry;
    MarketOracle public immutable oracle;
    LiquidityPool public immutable pool;
    IERC20 public immutable base;
    uint256 internal immutable _baseScale; // 10 ** (18 - base decimals)

    FacilityFactory public factory;
    Params internal _p;

    mapping(address facility => Record) internal _records;

    mapping(address adapter => bool) public isAdapter;
    address public defaultAdapter;
    address[] internal _tokens;
    mapping(address token => bool) public isListed;
    mapping(address token => bool) public isTradeable;
    mapping(address token => uint256) internal _tokenUnit; // 10 ** decimals

    event ParamsSet(Params params);
    event AdapterSet(address indexed adapter, bool allowed);
    event DefaultAdapterSet(address indexed adapter);
    event TradeTokenSet(address indexed token, bool tradeable);
    event StateChanged(address indexed facility, State from, State to, uint256 U, uint256 H);
    event FreezeStarted(address indexed facility, uint64 at);
    event CureStarted(address indexed facility, uint256 residualDebt, uint64 deadline);
    event Cured(address indexed facility);
    event Defaulted(address indexed facility, uint256 debt);
    event ResolutionRequested(address indexed facility, uint256 residualDebt, bytes32 custodyRef);
    event Deleveraged(
        address indexed facility, address indexed caller, uint256 proceeds, uint256 repaid, uint256 tip, uint256 residual
    );
    event SettlementConfirmed(address indexed facility, uint256 amount, bytes32 evidenceHash, uint256 loss);
    event CashedOut(address indexed facility, address indexed to, uint256 proceeds, uint256 repaid, uint256 paidOut);

    error InvalidParams();
    error FactoryAlreadySet();
    error NotFacility();
    error StateNotAllowed(State state);
    error AttestationNotValid(AttStatus status);
    error PriceDegraded();
    error ExceedsCredit(uint256 debtAfter, uint256 maxDebt);
    error AdapterNotAllowed(address adapter);
    error TokenNotAllowed(address token);
    error PositionTooLarge(address token, uint256 valueUsd);
    error NotSurplus(uint256 requested, uint256 surplus);
    error CannotDeleverage(State state);
    error NotBroker();
    error NotDefaulted();
    error TooManyTokens();
    error NotFacilityOwner();
    error DebtRemains(uint256 residual);
    error ZeroAddress();

    constructor(
        address owner_,
        CollateralRegistry registry_,
        MarketOracle oracle_,
        LiquidityPool pool_,
        Params memory params_
    ) Ownable(owner_) {
        registry = registry_;
        oracle = oracle_;
        pool = pool_;
        base = pool_.asset();
        uint8 dec = IERC20Metadata(address(base)).decimals();
        if (dec > 18) revert InvalidParams();
        _baseScale = 10 ** (18 - dec);
        _setParams(params_);
    }

    // ================================================================ admin

    function setFactory(FacilityFactory factory_) external onlyOwner {
        if (address(factory) != address(0)) revert FactoryAlreadySet();
        factory = factory_;
    }

    function setParams(Params calldata params_) external onlyOwner {
        _setParams(params_);
    }

    function setAdapter(address adapter, bool allowed) external onlyOwner {
        isAdapter[adapter] = allowed;
        if (!allowed && defaultAdapter == adapter) defaultAdapter = address(0);
        emit AdapterSet(adapter, allowed);
    }

    function setDefaultAdapter(address adapter) external onlyOwner {
        if (!isAdapter[adapter]) revert AdapterNotAllowed(adapter);
        defaultAdapter = adapter;
        emit DefaultAdapterSet(adapter);
    }

    /// @notice List a stock token for trading. Delisting only blocks buys; holdings stay valued and sellable.
    function setTradeToken(address token, bool tradeable) external onlyOwner {
        if (token == address(base) || !oracle.isRegistered(token)) revert TokenNotAllowed(token);
        if (!isListed[token]) {
            if (_tokens.length >= MAX_TRADE_TOKENS) revert TooManyTokens();
            isListed[token] = true;
            _tokens.push(token);
            _tokenUnit[token] = 10 ** IERC20Metadata(token).decimals();
        }
        isTradeable[token] = tradeable;
        emit TradeTokenSet(token, tradeable);
    }

    // ================================================================ views

    function params() external view returns (Params memory) {
        return _p;
    }

    function recordOf(address facility) external view returns (Record memory) {
        return _records[facility];
    }

    function tradeTokens() external view returns (address[] memory) {
        return _tokens;
    }

    function evaluate(address facility) external view returns (Evaluation memory) {
        return _evaluate(facility);
    }

    function canDeleverage(address facility) external view returns (bool) {
        return _canDeleverage(_evaluate(facility), _records[facility]);
    }

    // ================================================================ facility checks (called by CreditFacility)

    /// @dev Worst case: the new USDG is fully invested in the riskiest tradeable stock at its session haircut.
    function checkBorrow(address facility, uint256 amount) external view {
        Evaluation memory e = _evaluate(facility);
        if (e.state != State.ACTIVE) revert StateNotAllowed(e.state);
        if (e.att != AttStatus.VALID) revert AttestationNotValid(e.att);
        if (e.degraded) revert PriceDegraded();
        uint256 exposureAfter = e.exposure + amount * _baseScale * _maxTradeHaircutBps() / BPS;
        uint256 maxExposure = e.creditLimit * _p.maxBorrowUtilBps / BPS;
        if (exposureAfter > maxExposure) revert ExceedsCredit(exposureAfter, maxExposure);
    }

    /// @notice Largest borrow that passes `checkBorrow` right now, in base asset units (UI helper).
    function buyingPower(address facility) external view returns (uint256) {
        Evaluation memory e = _evaluate(facility);
        if (e.state != State.ACTIVE || e.att != AttStatus.VALID || e.degraded) return 0;
        uint256 maxExposure = e.creditLimit * _p.maxBorrowUtilBps / BPS;
        uint256 hc = _maxTradeHaircutBps();
        if (maxExposure <= e.exposure || hc == 0) return 0;
        return (maxExposure - e.exposure) * BPS / hc / _baseScale;
    }

    function checkIncrease(address facility, address adapter, address token) external view {
        Evaluation memory e = _evaluate(facility);
        if (e.state != State.ACTIVE && e.state != State.WARNING) revert StateNotAllowed(e.state);
        if (e.att != AttStatus.VALID) revert AttestationNotValid(e.att);
        if (e.degraded) revert PriceDegraded();
        if (!isAdapter[adapter]) revert AdapterNotAllowed(adapter);
        if (!isTradeable[token]) revert TokenNotAllowed(token);
    }

    /// @param positionCapUsd extra cap from the agent's mandate (0 = global cap only)
    function checkPostIncrease(address facility, address token, uint256 positionCapUsd) external view {
        Evaluation memory e = _evaluate(facility);
        if (e.state != State.ACTIVE && e.state != State.WARNING) revert StateNotAllowed(e.state);
        uint256 maxExposure = e.creditLimit * _p.maxBorrowUtilBps / BPS;
        if (e.exposure > maxExposure) revert ExceedsCredit(e.exposure, maxExposure);
        uint256 bal = IERC20(token).balanceOf(facility);
        uint256 value = Math.mulDiv(bal, oracle.quote(token).mark, _tokenUnit[token]);
        uint256 cap = _p.maxPositionUsd;
        if (positionCapUsd != 0 && positionCapUsd < cap) cap = positionCapUsd;
        if (value > cap || value * BPS > e.assets * _p.maxPerTokenBps) {
            revert PositionTooLarge(token, value);
        }
    }

    function checkReduce(address facility, address adapter, address token) external view {
        State s = _evaluate(facility).state;
        if (s == State.DEFAULT || s == State.CLOSED) revert StateNotAllowed(s);
        if (!isAdapter[adapter]) revert AdapterNotAllowed(adapter);
        if (!isListed[token]) revert TokenNotAllowed(token);
    }

    function checkDeposit(address facility) external view {
        State s = _evaluate(facility).state;
        if (s == State.DEFAULT || s == State.CLOSED) revert StateNotAllowed(s);
    }

    function checkWithdraw(address facility, uint256 amount) external view {
        Evaluation memory e = _evaluate(facility);
        if (e.state != State.ACTIVE) revert StateNotAllowed(e.state);
        if (e.debt > 0 && e.att != AttStatus.VALID) revert AttestationNotValid(e.att);
        uint256 surplus = e.assets > e.debt ? e.assets - e.debt : 0;
        if (amount * _baseScale > surplus) revert NotSurplus(amount * _baseScale, surplus);
    }

    // ================================================================ keeper entry points (permissionless)

    function poke(address facility) external returns (State) {
        if (!factory.isFacility(facility)) revert NotFacility();
        return _poke(facility);
    }

    /// @notice Flatten all holdings to USDG at oracle-bounded prices and repay. No calldata from the caller.
    function deleverage(address facility) external nonReentrant returns (uint256 residual) {
        if (!factory.isFacility(facility)) revert NotFacility();
        Record storage r = _records[facility];
        Evaluation memory e = _evaluate(facility);
        if (!_canDeleverage(e, r)) revert CannotDeleverage(e.state);

        uint256 proceeds = _flatten(facility);
        uint256 tip = proceeds * _p.keeperTipBps / BPS;
        if (tip > _p.maxKeeperTip) tip = _p.maxKeeperTip;
        if (tip > 0) CreditFacility(facility).pay(msg.sender, tip);
        uint256 repaid = CreditFacility(facility).forceRepay();

        residual = pool.debtOf(facility);
        if (residual > 0) {
            r.phase = Phase.CURE;
            r.cureStartedAt = uint64(block.timestamp);
            emit CureStarted(facility, residual, uint64(block.timestamp) + _p.cureWindow);
        }
        r.level = Level.HEALTHY;
        emit Deleveraged(facility, msg.sender, proceeds, repaid, tip, residual);
        _poke(facility);
    }

    // ================================================================ owner exit

    /// @notice Close out a facility in one call: sell every holding at oracle-bounded prices, repay all debt,
    /// revoke the agent and send the remaining USDG to `to`. Reverts with `DebtRemains` if the sale does not
    /// cover the debt; repay the difference with `CreditFacility.repayFrom` first.
    function cashOut(address facility, address to) external nonReentrant returns (uint256 paidOut) {
        if (!factory.isFacility(facility)) revert NotFacility();
        if (msg.sender != CreditFacility(facility).owner()) revert NotFacilityOwner();
        if (to == address(0)) revert ZeroAddress();
        State s = _evaluate(facility).state;
        if (s == State.DEFAULT || s == State.CLOSED) revert StateNotAllowed(s);

        uint256 proceeds = _flatten(facility);
        uint256 repaid = CreditFacility(facility).forceRepay();
        uint256 residual = pool.debtOf(facility);
        if (residual > 0) revert DebtRemains(residual);

        paidOut = CreditFacility(facility).release(to);
        emit CashedOut(facility, to, proceeds, repaid, paidOut);
        _poke(facility);
    }

    // ================================================================ broker settlement (simulated offchain sale)

    /// @notice The facility's broker reports the offchain sale of pledged shares and pays the proceeds in USDG.
    /// Any remaining holdings are flattened first; any shortfall is written off by the pool.
    function confirmSettlement(address facility, uint256 amount, bytes32 evidenceHash) external nonReentrant {
        if (!factory.isFacility(facility)) revert NotFacility();
        if (msg.sender != registry.brokerOf(facility)) revert NotBroker();
        Record storage r = _records[facility];
        if (r.phase != Phase.DEFAULT) {
            _poke(facility);
            if (r.phase != Phase.DEFAULT) revert NotDefaulted();
        }

        _flatten(facility);
        CreditFacility(facility).forceRepay();

        uint256 debt = pool.debtOf(facility);
        uint256 used = amount < debt ? amount : debt;
        if (used > 0) {
            base.safeTransferFrom(msg.sender, address(this), used);
            base.forceApprove(address(pool), used);
            pool.repay(facility, used);
            base.forceApprove(address(pool), 0);
        }
        uint256 loss = pool.debtOf(facility) > 0 ? pool.absorbLoss(facility) : 0;

        r.phase = Phase.CLOSED;
        emit SettlementConfirmed(facility, used, evidenceHash, loss);
        _poke(facility);
    }

    // ================================================================ internal: evaluation

    function _evaluate(address facility) internal view returns (Evaluation memory e) {
        Record storage r = _records[facility];
        e.att = registry.status(facility);
        e.debt = pool.debtOf(facility) * _baseScale;

        uint256 stressed = _valueHoldings(facility, e);
        e.exposure = e.debt > stressed ? e.debt - stressed : 0;
        if (e.att != AttStatus.NONE) _valueCollateral(facility, e);

        if (e.debt == 0) {
            e.U = 0;
            e.H = type(uint256).max;
            e.level = Level.HEALTHY;
        } else {
            e.U = e.exposure == 0
                ? 0
                : e.creditLimit == 0 ? type(uint256).max : Math.mulDiv(e.exposure, WAD, e.creditLimit);
            e.H = Math.mulDiv(e.assets, WAD, e.debt);
            e.level = _applyHysteresis(_level(e.U, e.H), r.level, e.U, e.H);
        }

        e.state = _state(e, r);
    }

    /// @dev Sets `e.assets` (at mark) and returns stressed assets (holdings after their session haircut).
    function _valueHoldings(address facility, Evaluation memory e) internal view returns (uint256 stressed) {
        e.assets = base.balanceOf(facility) * _baseScale;
        stressed = e.assets;
        uint256 n = _tokens.length;
        for (uint256 i; i < n; ++i) {
            address t = _tokens[i];
            uint256 bal = IERC20(t).balanceOf(facility);
            if (bal == 0) continue;
            MarketOracle.Quote memory q = oracle.quote(t);
            uint256 value = Math.mulDiv(bal, q.mark, _tokenUnit[t]);
            e.assets += value;
            stressed += value * (BPS - oracle.haircutBps(t, q.closed)) / BPS;
            if (q.closed) e.anyClosed = true;
            if (q.degraded) e.degraded = true;
        }
    }

    function _maxTradeHaircutBps() internal view returns (uint256 maxHc) {
        uint256 n = _tokens.length;
        for (uint256 i; i < n; ++i) {
            address t = _tokens[i];
            if (!isTradeable[t]) continue;
            uint256 hc = oracle.haircutBps(t, oracle.quote(t).closed);
            if (hc > maxHc) maxHc = hc;
        }
    }

    function _valueCollateral(address facility, Evaluation memory e) internal view {
        Position[] memory ps = registry.positions(facility);
        CollateralRegistry.Record memory rec = registry.record(facility);
        uint256 eligible = rec.cashUsd;
        for (uint256 i; i < ps.length; ++i) {
            MarketOracle.Quote memory q = oracle.quote(ps[i].asset);
            uint256 hc = oracle.haircutBps(ps[i].asset, q.closed);
            eligible += Math.mulDiv(ps[i].shares, q.mark, WAD) * (BPS - hc) / BPS;
            if (q.closed) e.anyClosed = true;
            if (q.degraded) e.degraded = true;
        }
        eligible = eligible > rec.encumberedUsd ? eligible - rec.encumberedUsd : 0;
        uint256 limit = eligible * _p.maxLtvBps / BPS;
        e.creditLimit = limit < _p.maxCreditPerFacility ? limit : _p.maxCreditPerFacility;
    }

    function _state(Evaluation memory e, Record storage r) internal view returns (State) {
        if (r.phase == Phase.CLOSED) return State.CLOSED;
        if (r.phase == Phase.DEFAULT) return State.DEFAULT;
        if (r.phase == Phase.CURE && e.debt > 0) {
            return block.timestamp >= uint256(r.cureStartedAt) + _p.cureWindow ? State.DEFAULT : State.CURE;
        }
        if (e.att == AttStatus.STALE || e.att == AttStatus.REVOKED) {
            if (e.debt > 0 && r.frozenAt != 0 && block.timestamp >= uint256(r.frozenAt) + _p.defaultGrace) {
                return State.DEFAULT;
            }
            return State.FROZEN;
        }
        if (e.level == Level.DELEVERAGING) return State.DELEVERAGING;
        if (e.level == Level.MARGIN_CALL) return State.MARGIN_CALL;
        if (e.level == Level.WARNING) return State.WARNING;
        return State.ACTIVE;
    }

    function _level(uint256 U, uint256 H) internal view returns (Level) {
        Level lu = U >= _p.uDelevBps * BPS_TO_WAD
            ? Level.DELEVERAGING
            : U >= _p.uCallBps * BPS_TO_WAD ? Level.MARGIN_CALL : U >= _p.uWarnBps * BPS_TO_WAD ? Level.WARNING : Level.HEALTHY;
        Level lh = H < _p.hDelevBps * BPS_TO_WAD
            ? Level.DELEVERAGING
            : H < _p.hCallBps * BPS_TO_WAD ? Level.MARGIN_CALL : H < _p.hWarnBps * BPS_TO_WAD ? Level.WARNING : Level.HEALTHY;
        return lu > lh ? lu : lh;
    }

    /// @dev A persisted level only downgrades when the signals clear the lower threshold by `hysteresisBps`.
    function _applyHysteresis(Level raw, Level persisted, uint256 U, uint256 H) internal view returns (Level) {
        if (raw >= persisted) return raw;
        uint256 h = _p.hysteresisBps * BPS_TO_WAD;
        uint256 uMargin = U > type(uint256).max - h ? type(uint256).max : U + h;
        uint256 hMargin = H > h ? H - h : 0;
        Level withMargin = _level(uMargin, hMargin);
        return withMargin < persisted ? withMargin : persisted;
    }

    function _canDeleverage(Evaluation memory e, Record storage r) internal view returns (bool) {
        if (e.debt == 0) return false;
        if (e.state == State.DELEVERAGING) return true;
        if (e.state != State.FROZEN) return false;
        return e.level == Level.DELEVERAGING
            || (r.frozenAt != 0 && block.timestamp >= uint256(r.frozenAt) + _p.freezeGrace);
    }

    // ================================================================ internal: state persistence

    function _poke(address facility) internal returns (State) {
        Record storage r = _records[facility];
        Evaluation memory e = _evaluate(facility);

        if (e.state == State.FROZEN) {
            if (r.frozenAt == 0) {
                r.frozenAt = uint64(block.timestamp);
                emit FreezeStarted(facility, r.frozenAt);
            }
        } else if (e.state != State.DEFAULT && r.frozenAt != 0) {
            r.frozenAt = 0;
        }

        if (r.phase == Phase.CURE && e.debt == 0) {
            r.phase = Phase.NORMAL;
            r.cureStartedAt = 0;
            emit Cured(facility);
        }

        if (e.state == State.DEFAULT && r.phase != Phase.DEFAULT) {
            r.phase = Phase.DEFAULT;
            emit Defaulted(facility, e.debt);
            emit ResolutionRequested(facility, e.debt, registry.record(facility).custodyRef);
        }

        r.level = e.level;
        if (e.state != r.lastState) {
            emit StateChanged(facility, r.lastState, e.state, e.U, e.H);
            r.lastState = e.state;
        }
        return e.state;
    }

    /// @dev Sell every listed holding to the base asset through the default venue, bounded by the live price.
    function _flatten(address facility) internal returns (uint256 proceeds) {
        address adapter = defaultAdapter;
        uint256 n = _tokens.length;
        for (uint256 i; i < n; ++i) {
            address t = _tokens[i];
            uint256 bal = IERC20(t).balanceOf(facility);
            if (bal == 0) continue;
            uint256 usd = Math.mulDiv(bal, oracle.quote(t).live, _tokenUnit[t]);
            uint256 minOut = usd * (BPS - _p.maxSlippageBps) / BPS / _baseScale;
            proceeds += CreditFacility(facility).forceSell(adapter, t, bal, minOut);
        }
    }

    function _setParams(Params memory p) internal {
        if (
            p.maxLtvBps == 0 || p.maxLtvBps > 9_000 || p.maxBorrowUtilBps == 0 || p.maxBorrowUtilBps >= p.uWarnBps
                || p.uWarnBps >= p.uCallBps || p.uCallBps >= p.uDelevBps || p.uDelevBps > 15_000
                || p.hWarnBps > BPS || p.hWarnBps <= p.hCallBps || p.hCallBps <= p.hDelevBps || p.hDelevBps < 5_000
                || p.hysteresisBps > 1_000 || p.maxSlippageBps > 1_000 || p.keeperTipBps > 200
                || p.maxPerTokenBps == 0 || p.maxPerTokenBps > BPS || p.cureWindow == 0
                || p.freezeGrace >= p.defaultGrace
        ) revert InvalidParams();
        _p = p;
        emit ParamsSet(p);
    }
}
