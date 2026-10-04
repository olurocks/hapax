// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVenueAdapter} from "./interfaces/IVenueAdapter.sol";
import {LiquidityPool} from "./LiquidityPool.sol";

interface IRiskChecks {
    function checkBorrow(address facility, uint256 amount) external view;
    function checkIncrease(address facility, address adapter, address token) external view;
    function checkReduce(address facility, address adapter, address token) external view;
    function checkPostIncrease(address facility, address token, uint256 positionCapUsd) external view;
    function checkDeposit(address facility) external view;
    function checkWithdraw(address facility, uint256 amount) external view;
}

/// @title CreditFacility
/// @notice Per-borrower smart account that holds borrowed USDG and the stock tokens bought with it.
/// Funds can only move through the paths below; every state-increasing action is risk-checked fresh.
///
///   owner : borrow, repay, deposit, trade, withdrawSurplus, setAgent, revokeAgent (cash out via RiskManager)
///   agent : trade within its mandate, repay. An AI agent gets buying power, never keys: it cannot borrow,
///           withdraw, change its own mandate, or move funds anywhere except allowlisted venues.
///   anyone: deposit, repayFrom (repay debt with their own USDG)
///   risk  : forceSell, forceRepay, pay (keeper tip), release (cash out) during deleverage, settlement, cash out
///
/// `contributed` and `distributed` count USDG that crossed the facility boundary from and to outside wallets
/// (borrowing is not counted: it adds equal assets and debt). Owner P&L = assets - debt - contributed + distributed.
///
/// Deployed as an ERC-1167 clone by FacilityFactory.
contract CreditFacility is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice What the owner lets the agent do. Enforced onchain on every agent trade.
    struct Mandate {
        uint64 expiresAt; // agent loses all rights after this
        uint192 maxPositionUsd; // per-token position cap for agent buys, USD 1e18 (0 = only the global cap)
    }

    address public owner;
    address public agent;
    address public risk;
    LiquidityPool public pool;
    IERC20 public base;
    bool private _initialized;

    Mandate internal _mandate;
    address[] internal _mandateTokens;
    mapping(address token => bool) public agentMayBuy;

    /// @notice USDG paid in from outside (deposits and repayments from a wallet), base units.
    uint256 public contributed;
    /// @notice USDG paid out to the owner (withdrawals and cash-outs), base units.
    uint256 public distributed;

    event AgentSet(address indexed agent, uint64 expiresAt, uint256 maxPositionUsd, address[] tokens);
    event AgentRevoked(address indexed agent);
    event Borrowed(uint256 amount);
    event Repaid(address indexed by, uint256 amount);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event Traded(
        address indexed by,
        address indexed adapter,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event ForceSold(address indexed token, uint256 amountIn, uint256 baseOut);
    event CashedOut(address indexed to, uint256 amount);

    error AlreadyInitialized();
    error Unauthorized();
    error InvalidPair();
    error SlippageExceeded();
    error ZeroAddress();
    error OutsideMandate(address token);

    constructor() {
        _initialized = true; // lock the implementation
    }

    function initialize(address owner_, address risk_, LiquidityPool pool_, IERC20 base_) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        owner = owner_;
        risk = risk_;
        pool = pool_;
        base = base_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOwnerOrAgent() {
        if (msg.sender != owner && !_isActiveAgent(msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyRisk() {
        if (msg.sender != risk) revert Unauthorized();
        _;
    }

    // ---------------------------------------------------------------- owner

    /// @notice Appoint an agent with a mandate. Replaces any previous agent and mandate.
    function setAgent(address agent_, uint64 expiresAt, uint192 maxPositionUsd, address[] calldata tokens)
        external
        onlyOwner
    {
        if (agent_ == address(0) || agent_ == owner) revert ZeroAddress();
        _clearMandateTokens();
        agent = agent_;
        _mandate = Mandate(expiresAt, maxPositionUsd);
        for (uint256 i; i < tokens.length; ++i) {
            agentMayBuy[tokens[i]] = true;
            _mandateTokens.push(tokens[i]);
        }
        emit AgentSet(agent_, expiresAt, maxPositionUsd, tokens);
    }

    /// @notice Kill switch: the agent loses every right immediately.
    function revokeAgent() external onlyOwner {
        emit AgentRevoked(agent);
        _clearMandateTokens();
        agent = address(0);
        delete _mandate;
    }

    function borrow(uint256 amount) external onlyOwner nonReentrant {
        IRiskChecks(risk).checkBorrow(address(this), amount);
        pool.borrow(amount);
        emit Borrowed(amount);
    }

    function deposit(uint256 amount) external nonReentrant {
        IRiskChecks(risk).checkDeposit(address(this));
        base.safeTransferFrom(msg.sender, address(this), amount);
        contributed += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdrawSurplus(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IRiskChecks(risk).checkWithdraw(address(this), amount);
        base.safeTransfer(to, amount);
        distributed += amount;
        emit Withdrawn(to, amount);
    }

    // ---------------------------------------------------------------- anyone

    /// @notice Repay debt with the caller's own USDG instead of the facility's balance. Capped at the debt.
    /// Never blocked by the facility's state: repaying only ever reduces risk.
    function repayFrom(uint256 amount) external nonReentrant returns (uint256 paid) {
        uint256 debt = pool.debtOf(address(this));
        paid = amount < debt ? amount : debt;
        if (paid == 0) return 0;
        base.safeTransferFrom(msg.sender, address(this), paid);
        base.forceApprove(address(pool), paid);
        paid = pool.repay(address(this), paid);
        base.forceApprove(address(pool), 0);
        contributed += paid;
        emit Repaid(msg.sender, paid);
    }

    // ---------------------------------------------------------------- owner or agent

    function repay(uint256 amount) external onlyOwnerOrAgent nonReentrant returns (uint256) {
        return _repay(amount, msg.sender);
    }

    /// @notice Buy a stock token with USDG, or sell one back to USDG, through an allowlisted venue.
    /// Agent buys must also fit the mandate (token list and position cap). Sells always reduce risk.
    function trade(address adapter, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        onlyOwnerOrAgent
        nonReentrant
        returns (uint256 amountOut)
    {
        bool isBuy = tokenIn == address(base);
        if (isBuy == (tokenOut == address(base))) revert InvalidPair();
        bool byAgent = msg.sender != owner;

        if (isBuy) {
            if (byAgent && !agentMayBuy[tokenOut]) revert OutsideMandate(tokenOut);
            IRiskChecks(risk).checkIncrease(address(this), adapter, tokenOut);
        } else {
            IRiskChecks(risk).checkReduce(address(this), adapter, tokenIn);
        }

        amountOut = _swap(adapter, tokenIn, tokenOut, amountIn, minOut);

        if (isBuy) {
            IRiskChecks(risk).checkPostIncrease(address(this), tokenOut, byAgent ? _mandate.maxPositionUsd : 0);
        }
        emit Traded(msg.sender, adapter, tokenIn, tokenOut, amountIn, amountOut);
    }

    // ---------------------------------------------------------------- risk manager

    function forceSell(address adapter, address token, uint256 amount, uint256 minOut)
        external
        onlyRisk
        nonReentrant
        returns (uint256 baseOut)
    {
        baseOut = _swap(adapter, token, address(base), amount, minOut);
        emit ForceSold(token, amount, baseOut);
    }

    function forceRepay() external onlyRisk nonReentrant returns (uint256) {
        return _repay(type(uint256).max, msg.sender);
    }

    function pay(address to, uint256 amount) external onlyRisk nonReentrant {
        base.safeTransfer(to, amount);
    }

    /// @notice Final step of a cash-out: the agent loses its rights and every USDG left goes to `to`.
    function release(address to) external onlyRisk nonReentrant returns (uint256 amount) {
        if (agent != address(0)) {
            emit AgentRevoked(agent);
            _clearMandateTokens();
            agent = address(0);
            delete _mandate;
        }
        amount = base.balanceOf(address(this));
        if (amount > 0) base.safeTransfer(to, amount);
        distributed += amount;
        emit CashedOut(to, amount);
    }

    // ---------------------------------------------------------------- views

    function mandate() external view returns (Mandate memory m, address[] memory tokens, bool active) {
        return (_mandate, _mandateTokens, _isActiveAgent(agent));
    }

    // ---------------------------------------------------------------- internal

    function _isActiveAgent(address who) internal view returns (bool) {
        return who != address(0) && who == agent && block.timestamp < _mandate.expiresAt;
    }

    function _clearMandateTokens() internal {
        for (uint256 i; i < _mandateTokens.length; ++i) {
            agentMayBuy[_mandateTokens[i]] = false;
        }
        delete _mandateTokens;
    }

    function _repay(uint256 amount, address by) internal returns (uint256 paid) {
        uint256 bal = base.balanceOf(address(this));
        uint256 debt = pool.debtOf(address(this));
        uint256 amt = amount;
        if (amt > bal) amt = bal;
        if (amt > debt) amt = debt;
        if (amt == 0) return 0;
        base.forceApprove(address(pool), amt);
        paid = pool.repay(address(this), amt);
        base.forceApprove(address(pool), 0);
        emit Repaid(by, paid);
    }

    function _swap(address adapter, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 received)
    {
        IERC20 tIn = IERC20(tokenIn);
        IERC20 tOut = IERC20(tokenOut);
        uint256 in0 = tIn.balanceOf(address(this));
        uint256 out0 = tOut.balanceOf(address(this));

        tIn.forceApprove(adapter, amountIn);
        IVenueAdapter(adapter).swap(tokenIn, tokenOut, amountIn, minOut);
        tIn.forceApprove(adapter, 0);

        // Trust balances, not the adapter's return value.
        uint256 in1 = tIn.balanceOf(address(this));
        uint256 out1 = tOut.balanceOf(address(this));
        if (in0 - in1 > amountIn) revert SlippageExceeded();
        received = out1 - out0;
        if (received < minOut) revert SlippageExceeded();
    }
}
