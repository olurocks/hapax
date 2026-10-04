// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RiskManager} from "../src/RiskManager.sol";

/// @notice Demo parameters (docs/ARCHITECTURE.md section 14). Short timers so every scene fits in a video.
library DemoConfig {
    // Robinhood Chain testnet (46630)
    address internal constant RH_TESTNET_USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;
    address internal constant RH_TESTNET_TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address internal constant RH_TESTNET_AMZN = 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02;
    address internal constant RH_TESTNET_NFLX = 0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93;

    uint32 internal constant REF_HEARTBEAT = 5 minutes;
    uint32 internal constant LIVE_MAX_AGE = 5 minutes;
    uint16 internal constant MAX_DEVIATION_BPS = 300;
    uint16 internal constant HAIRCUT_BPS = 2_500;
    uint16 internal constant WEEKEND_HAIRCUT_BPS = 4_000;
    uint64 internal constant MAX_ATTESTATION_TTL = 1 hours;
    uint16 internal constant POOL_APR_BPS = 500;
    uint16 internal constant VENUE_SPREAD_BPS = 10;

    function params(uint8 baseDecimals) internal pure returns (RiskManager.Params memory) {
        return RiskManager.Params({
            maxLtvBps: 8_000,
            maxBorrowUtilBps: 7_000,
            uWarnBps: 8_000,
            uCallBps: 9_000,
            uDelevBps: 10_000,
            hWarnBps: 9_500,
            hCallBps: 9_000,
            hDelevBps: 8_500,
            hysteresisBps: 200,
            maxSlippageBps: 100,
            keeperTipBps: 25,
            maxPerTokenBps: 10_000,
            cureWindow: 120,
            freezeGrace: 120,
            defaultGrace: 300,
            maxKeeperTip: 1_000 * 10 ** baseDecimals,
            maxCreditPerFacility: 10_000_000e18,
            maxPositionUsd: 1_000_000e18
        });
    }
}
