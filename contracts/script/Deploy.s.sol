// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {MarketOracle} from "../src/MarketOracle.sol";
import {CollateralRegistry} from "../src/CollateralRegistry.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {RiskManager} from "../src/RiskManager.sol";
import {FacilityFactory} from "../src/FacilityFactory.sol";
import {DemoFeed} from "../src/demo/DemoFeed.sol";
import {DemoVenue} from "../src/demo/DemoVenue.sol";
import {MockERC20} from "../src/demo/MockERC20.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {DemoConfig} from "./DemoConfig.sol";

/// @notice Deploys Hapax and writes addresses to deployments/<chainId>.json.
///
/// Env:
///   DEPLOYER_PK     deployer / admin / demo operator key
///   BROKER_ADDRESS  broker simulator signer
///   USE_MOCKS       true => deploy mock USDG and stock tokens (local Anvil, or if testnet faucets run dry)
///   USDG, TSLA, AMZN, NFLX  optional overrides; default to Robinhood Chain testnet addresses
contract Deploy is Script {
    struct Deployed {
        address usdg;
        address[3] stocks;
        address[3] refFeeds;
        address[3] liveFeeds;
        address oracle;
        address registry;
        address pool;
        address risk;
        address factory;
        address venue;
    }

    string[3] internal SYMBOLS = ["TSLA", "AMZN", "NFLX"];
    int256[3] internal PRICES = [int256(250e8), int256(200e8), int256(100e8)];

    function run() external returns (Deployed memory d) {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address admin = vm.addr(pk);
        address broker = vm.envAddress("BROKER_ADDRESS");
        bool mocks = vm.envOr("USE_MOCKS", false);

        vm.startBroadcast(pk);

        if (mocks) {
            d.usdg = address(new MockERC20("Global Dollar (mock)", "USDG", 6));
            for (uint256 i; i < 3; ++i) {
                d.stocks[i] = address(new MockERC20(SYMBOLS[i], SYMBOLS[i], 18));
            }
        } else {
            d.usdg = vm.envOr("USDG", DemoConfig.RH_TESTNET_USDG);
            d.stocks[0] = vm.envOr("TSLA", DemoConfig.RH_TESTNET_TSLA);
            d.stocks[1] = vm.envOr("AMZN", DemoConfig.RH_TESTNET_AMZN);
            d.stocks[2] = vm.envOr("NFLX", DemoConfig.RH_TESTNET_NFLX);
        }

        MarketOracle oracle = new MarketOracle(admin);
        for (uint256 i; i < 3; ++i) {
            DemoFeed ref = new DemoFeed(admin, string.concat(SYMBOLS[i], " / USD reference (demo)"), 8, PRICES[i]);
            DemoFeed live = new DemoFeed(admin, string.concat(SYMBOLS[i], " / USD live (demo)"), 8, PRICES[i]);
            d.refFeeds[i] = address(ref);
            d.liveFeeds[i] = address(live);
            oracle.setAsset(
                d.stocks[i],
                MarketOracle.AssetConfig({
                    refFeed: AggregatorV3Interface(address(ref)),
                    liveFeed: AggregatorV3Interface(address(live)),
                    refHeartbeat: DemoConfig.REF_HEARTBEAT,
                    liveMaxAge: DemoConfig.LIVE_MAX_AGE,
                    maxDeviationBps: DemoConfig.MAX_DEVIATION_BPS,
                    haircutBps: DemoConfig.HAIRCUT_BPS,
                    weekendHaircutBps: DemoConfig.WEEKEND_HAIRCUT_BPS,
                    enabled: true
                })
            );
        }

        CollateralRegistry registry = new CollateralRegistry(admin, oracle, DemoConfig.MAX_ATTESTATION_TTL);
        LiquidityPool pool = new LiquidityPool(admin, IERC20(d.usdg), DemoConfig.POOL_APR_BPS);
        RiskManager risk = new RiskManager(
            admin, registry, oracle, pool, DemoConfig.params(IERC20Metadata(d.usdg).decimals())
        );
        FacilityFactory factory = new FacilityFactory(address(risk), pool, IERC20(d.usdg));
        DemoVenue venue = new DemoVenue(admin, oracle, IERC20(d.usdg), DemoConfig.VENUE_SPREAD_BPS);

        pool.setFactory(address(factory));
        pool.setRiskManager(address(risk));
        registry.setFactory(address(factory));
        registry.setBroker(broker, true);
        risk.setFactory(factory);
        risk.setAdapter(address(venue), true);
        risk.setDefaultAdapter(address(venue));
        for (uint256 i; i < 3; ++i) {
            risk.setTradeToken(d.stocks[i], true);
        }

        if (mocks) {
            MockERC20(d.usdg).mint(admin, 2_000_000e6);
            IERC20(d.usdg).approve(address(pool), type(uint256).max);
            pool.supply(1_000_000e6);
            MockERC20(d.usdg).mint(address(venue), 1_000_000e6);
            for (uint256 i; i < 3; ++i) {
                MockERC20(d.stocks[i]).mint(address(venue), 10_000e18);
            }
        }

        vm.stopBroadcast();

        d.oracle = address(oracle);
        d.registry = address(registry);
        d.pool = address(pool);
        d.risk = address(risk);
        d.factory = address(factory);
        d.venue = address(venue);
        _write(d, admin, broker, mocks);
    }

    function _write(Deployed memory d, address admin, address broker, bool mocks) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeBool(k, "mocks", mocks);
        vm.serializeAddress(k, "admin", admin);
        vm.serializeAddress(k, "broker", broker);
        vm.serializeAddress(k, "usdg", d.usdg);
        vm.serializeAddress(k, "oracle", d.oracle);
        vm.serializeAddress(k, "registry", d.registry);
        vm.serializeAddress(k, "pool", d.pool);
        vm.serializeAddress(k, "risk", d.risk);
        vm.serializeAddress(k, "factory", d.factory);
        vm.serializeAddress(k, "venue", d.venue);

        string memory stocks = "stocks";
        for (uint256 i; i < 3; ++i) {
            string memory s = SYMBOLS[i];
            vm.serializeAddress(s, "token", d.stocks[i]);
            vm.serializeAddress(s, "refFeed", d.refFeeds[i]);
            string memory entry = vm.serializeAddress(s, "liveFeed", d.liveFeeds[i]);
            stocks = vm.serializeString("stocks", s, entry);
        }
        string memory json = vm.serializeString(k, "stocks", stocks);

        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Deployment written to", path);
    }
}
