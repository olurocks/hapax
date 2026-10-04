// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Attestation, Evaluation, Position, State} from "../src/libraries/Types.sol";
import {MarketOracle} from "../src/MarketOracle.sol";
import {CollateralRegistry} from "../src/CollateralRegistry.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {RiskManager} from "../src/RiskManager.sol";
import {FacilityFactory} from "../src/FacilityFactory.sol";
import {CreditFacility} from "../src/CreditFacility.sol";
import {DemoFeed} from "../src/demo/DemoFeed.sol";
import {DemoVenue} from "../src/demo/DemoVenue.sol";
import {MockERC20} from "../src/demo/MockERC20.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {DemoConfig} from "../script/DemoConfig.sol";

/// @notice Deploys the full system with the demo numbers from docs/ARCHITECTURE.md section 16:
/// brokerage account = 1,000 TSLA @ $250 + 500 AMZN @ $200 + $50k cash.
abstract contract BaseTest is Test {
    uint32 internal constant REF_HEARTBEAT = 1 hours;
    uint32 internal constant LIVE_MAX_AGE = 10 minutes;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    address internal agent = makeAddr("agent");
    uint256 internal brokerPk = 0xB0B;
    address internal broker;

    MockERC20 internal usdg;
    MockERC20 internal tsla;
    MockERC20 internal amzn;
    MockERC20 internal nflx;

    mapping(address => DemoFeed) internal refFeed;
    mapping(address => DemoFeed) internal liveFeed;
    mapping(address => int256) internal refPx; // 8 decimals
    mapping(address => int256) internal livePx;

    MarketOracle internal oracle;
    CollateralRegistry internal registry;
    LiquidityPool internal pool;
    RiskManager internal risk;
    FacilityFactory internal factory;
    DemoVenue internal venue;

    uint64 internal nonce;

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        broker = vm.addr(brokerPk);

        usdg = new MockERC20("Global Dollar", "USDG", 6);
        tsla = new MockERC20("Tesla", "TSLA", 18);
        amzn = new MockERC20("Amazon", "AMZN", 18);
        nflx = new MockERC20("Netflix", "NFLX", 18);

        vm.startPrank(admin);
        oracle = new MarketOracle(admin);
        _listAsset(address(tsla), 250e8);
        _listAsset(address(amzn), 200e8);
        _listAsset(address(nflx), 100e8);

        registry = new CollateralRegistry(admin, oracle, 1 days);
        pool = new LiquidityPool(admin, usdg, 500);
        risk = new RiskManager(admin, registry, oracle, pool, defaultParams());
        factory = new FacilityFactory(address(risk), pool, usdg);
        pool.setFactory(address(factory));
        pool.setRiskManager(address(risk));
        registry.setFactory(address(factory));
        risk.setFactory(factory);
        registry.setBroker(broker, true);

        venue = new DemoVenue(admin, oracle, usdg, 10);
        risk.setAdapter(address(venue), true);
        risk.setDefaultAdapter(address(venue));
        risk.setTradeToken(address(tsla), true);
        risk.setTradeToken(address(amzn), true);
        risk.setTradeToken(address(nflx), true);
        vm.stopPrank();

        // Lender liquidity and venue inventory.
        usdg.mint(admin, 1_000_000e6);
        vm.startPrank(admin);
        usdg.approve(address(pool), type(uint256).max);
        pool.supply(1_000_000e6);
        vm.stopPrank();
        usdg.mint(address(venue), 1_000_000e6);
        tsla.mint(address(venue), 10_000e18);
        amzn.mint(address(venue), 10_000e18);
        nflx.mint(address(venue), 10_000e18);
    }

    function defaultParams() internal pure returns (RiskManager.Params memory) {
        return DemoConfig.params(6);
    }

    // ---------------------------------------------------------------- market helpers

    function _listAsset(address asset, int256 px) internal {
        refFeed[asset] = new DemoFeed(admin, "ref", 8, px);
        liveFeed[asset] = new DemoFeed(admin, "live", 8, px);
        refPx[asset] = px;
        livePx[asset] = px;
        oracle.setAsset(
            asset,
            MarketOracle.AssetConfig({
                refFeed: AggregatorV3Interface(address(refFeed[asset])),
                liveFeed: AggregatorV3Interface(address(liveFeed[asset])),
                refHeartbeat: REF_HEARTBEAT,
                liveMaxAge: LIVE_MAX_AGE,
                maxDeviationBps: 300,
                haircutBps: 2_500,
                weekendHaircutBps: 4_000,
                enabled: true
            })
        );
    }

    function _assets() internal view returns (address[3] memory) {
        return [address(tsla), address(amzn), address(nflx)];
    }

    /// @dev Market open: reference and live feeds publish fresh prices.
    function _marketOpen() internal {
        address[3] memory xs = _assets();
        vm.startPrank(admin);
        for (uint256 i; i < 3; ++i) {
            refFeed[xs[i]].setAnswer(refPx[xs[i]]);
            liveFeed[xs[i]].setAnswer(livePx[xs[i]]);
        }
        vm.stopPrank();
    }

    /// @dev Friday 4pm: time passes beyond the reference heartbeat; only the 24/7 live market keeps publishing.
    function _marketClose() internal {
        vm.warp(block.timestamp + REF_HEARTBEAT + 1);
        _refreshLive();
    }

    function _refreshLive() internal {
        address[3] memory xs = _assets();
        vm.startPrank(admin);
        for (uint256 i; i < 3; ++i) {
            liveFeed[xs[i]].setAnswer(livePx[xs[i]]);
        }
        vm.stopPrank();
    }

    function _setLive(address asset, int256 px) internal {
        livePx[asset] = px;
        vm.prank(admin);
        liveFeed[asset].setAnswer(px);
    }

    // ---------------------------------------------------------------- facility helpers

    function _open(address who) internal returns (CreditFacility f) {
        vm.prank(who);
        f = CreditFacility(factory.openFacility());
    }

    function _attest(CreditFacility f, address borrower) internal {
        Position[] memory ps = new Position[](2);
        ps[0] = Position(address(tsla), 1_000e18);
        ps[1] = Position(address(amzn), 500e18);
        _attestWith(f, borrower, ps, 50_000e18, 0, 1 days);
    }

    function _attestWith(
        CreditFacility f,
        address borrower,
        Position[] memory ps,
        uint256 cashUsd,
        uint256 encumberedUsd,
        uint64 ttl
    ) internal {
        Attestation memory a = Attestation({
            facility: address(f),
            borrower: borrower,
            custodyRef: keccak256(abi.encode("acct", borrower)),
            positions: ps,
            cashUsd: cashUsd,
            encumberedUsd: encumberedUsd,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + ttl,
            nonce: ++nonce
        });
        registry.submit(a, _sign(brokerPk, a));
    }

    function _sign(uint256 pk, Attestation memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, registry.digest(a));
        return abi.encodePacked(r, s, v);
    }

    function _eval(CreditFacility f) internal view returns (Evaluation memory) {
        return risk.evaluate(address(f));
    }

    function _buy(CreditFacility f, address who, address token, uint256 usdgAmount) internal returns (uint256) {
        vm.prank(who);
        return f.trade(address(venue), address(usdg), token, usdgAmount, 0);
    }
}
