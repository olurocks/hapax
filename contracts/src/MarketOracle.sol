// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title MarketOracle
/// @notice Session-aware pricing for Robinhood stock tokens.
///
/// Each asset has a reference feed (Chainlink stock feed, updates 24/5 with market hours) and a live feed
/// (the 24/7 onchain market for the same stock token). The session is derived from reference-feed freshness,
/// so nights, weekends, holidays and early closes need no calendar:
///
///   OPEN   (reference fresh): mark = reference, or min(reference, live) if they deviate beyond the band
///   CLOSED (reference stale): mark = min(last reference, live); a weekend pump never lifts collateral
///                             above the last close, a weekend crash is seen immediately
///   CLOSED and live stale:    mark = last reference, flagged degraded (borrows and increases blocked)
///
/// All prices are USD per whole token, 1e18 fixed point.
contract MarketOracle is Ownable {
    struct AssetConfig {
        AggregatorV3Interface refFeed;
        AggregatorV3Interface liveFeed;
        uint32 refHeartbeat; // reference older than this => market closed
        uint32 liveMaxAge; // live older than this => no live price
        uint16 maxDeviationBps; // open-session band between reference and live
        uint16 haircutBps; // collateral haircut while the market is open
        uint16 weekendHaircutBps; // gap-risk haircut while the market is closed
        bool enabled;
    }

    struct Quote {
        uint256 mark; // conservative price used for risk valuation
        uint256 live; // executable price used for unwind bounds
        uint256 reference_; // latest reference price (last close when closed)
        bool closed;
        bool degraded;
    }

    uint16 public constant MAX_HAIRCUT_BPS = 9_000;
    uint16 public constant MAX_DEVIATION_BPS = 2_000;

    mapping(address asset => AssetConfig) internal _configs;
    address[] internal _assets;

    event AssetConfigured(
        address indexed asset,
        address refFeed,
        address liveFeed,
        uint32 refHeartbeat,
        uint32 liveMaxAge,
        uint16 maxDeviationBps,
        uint16 haircutBps,
        uint16 weekendHaircutBps
    );

    error AssetNotRegistered(address asset);
    error InvalidConfig();
    error InvalidPrice(address feed);

    constructor(address owner_) Ownable(owner_) {}

    function setAsset(address asset, AssetConfig calldata c) external onlyOwner {
        if (
            asset == address(0) || address(c.refFeed) == address(0) || c.refHeartbeat == 0
                || c.haircutBps > MAX_HAIRCUT_BPS || c.weekendHaircutBps > MAX_HAIRCUT_BPS
                || c.weekendHaircutBps < c.haircutBps || c.maxDeviationBps > MAX_DEVIATION_BPS
                || (address(c.liveFeed) != address(0) && c.liveMaxAge == 0)
        ) revert InvalidConfig();

        if (!_configs[asset].enabled) _assets.push(asset);
        AssetConfig storage s = _configs[asset];
        s.refFeed = c.refFeed;
        s.liveFeed = c.liveFeed;
        s.refHeartbeat = c.refHeartbeat;
        s.liveMaxAge = c.liveMaxAge;
        s.maxDeviationBps = c.maxDeviationBps;
        s.haircutBps = c.haircutBps;
        s.weekendHaircutBps = c.weekendHaircutBps;
        s.enabled = true;

        emit AssetConfigured(
            asset,
            address(c.refFeed),
            address(c.liveFeed),
            c.refHeartbeat,
            c.liveMaxAge,
            c.maxDeviationBps,
            c.haircutBps,
            c.weekendHaircutBps
        );
    }

    function isRegistered(address asset) external view returns (bool) {
        return _configs[asset].enabled;
    }

    function config(address asset) external view returns (AssetConfig memory) {
        return _configs[asset];
    }

    function assets() external view returns (address[] memory) {
        return _assets;
    }

    function quote(address asset) public view returns (Quote memory q) {
        AssetConfig storage c = _configs[asset];
        if (!c.enabled) revert AssetNotRegistered(asset);

        (uint256 refPrice, uint256 refAge) = _read(c.refFeed);
        q.reference_ = refPrice;
        q.closed = refAge > c.refHeartbeat;

        bool liveFresh;
        uint256 livePrice;
        if (address(c.liveFeed) != address(0)) {
            uint256 liveAge;
            (livePrice, liveAge) = _read(c.liveFeed);
            liveFresh = liveAge <= c.liveMaxAge;
        }

        if (!q.closed) {
            q.mark = refPrice;
            q.live = liveFresh ? livePrice : refPrice;
            if (liveFresh && _deviationBps(refPrice, livePrice) > c.maxDeviationBps) {
                q.mark = _min(refPrice, livePrice);
            }
        } else if (liveFresh) {
            q.mark = _min(refPrice, livePrice);
            q.live = livePrice;
        } else {
            q.mark = refPrice;
            q.live = refPrice;
            q.degraded = true;
        }
    }

    /// @notice Collateral haircut for `asset` given the current session.
    function haircutBps(address asset, bool closed) external view returns (uint16) {
        AssetConfig storage c = _configs[asset];
        if (!c.enabled) revert AssetNotRegistered(asset);
        return closed ? c.weekendHaircutBps : c.haircutBps;
    }

    function _read(AggregatorV3Interface feed) internal view returns (uint256 price, uint256 age) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0 || updatedAt == 0) revert InvalidPrice(address(feed));
        uint8 dec = feed.decimals();
        price = dec <= 18 ? uint256(answer) * 10 ** (18 - dec) : uint256(answer) / 10 ** (dec - 18);
        age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
    }

    function _deviationBps(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 diff = a > b ? a - b : b - a;
        return diff * 10_000 / a;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
