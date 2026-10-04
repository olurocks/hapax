// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVenueAdapter} from "../interfaces/IVenueAdapter.sol";
import {MarketOracle} from "../MarketOracle.sol";

/// @title DemoVenue
/// @notice Inventory-based testnet venue: quotes stock tokens against USDG at the oracle's live price with a fixed
/// spread. Funded by the operator. It is its own adapter. Stands in for a Uniswap pool when testnet liquidity is thin.
contract DemoVenue is IVenueAdapter, Ownable {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    MarketOracle public immutable oracle;
    IERC20 public immutable base;
    uint256 internal immutable _baseUnit;
    uint16 public spreadBps;

    event Swapped(address indexed trader, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);

    error InvalidPair();
    error SlippageExceeded();
    error SpreadTooHigh();

    constructor(address owner_, MarketOracle oracle_, IERC20 base_, uint16 spreadBps_) Ownable(owner_) {
        oracle = oracle_;
        base = base_;
        _baseUnit = 10 ** IERC20Metadata(address(base_)).decimals();
        _setSpread(spreadBps_);
    }

    function setSpread(uint16 spreadBps_) external onlyOwner {
        _setSpread(spreadBps_);
    }

    function withdraw(IERC20 token, uint256 amount, address to) external onlyOwner {
        token.safeTransfer(to, amount);
    }

    function quoteOut(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        if (tokenIn == address(base) && tokenOut != address(base)) {
            uint256 price = oracle.quote(tokenOut).live;
            uint256 usd = Math.mulDiv(amountIn, 1e18, _baseUnit);
            uint256 unit = 10 ** IERC20Metadata(tokenOut).decimals();
            return Math.mulDiv(usd, unit, price) * (BPS - spreadBps) / BPS;
        }
        if (tokenOut == address(base) && tokenIn != address(base)) {
            uint256 price = oracle.quote(tokenIn).live;
            uint256 unit = 10 ** IERC20Metadata(tokenIn).decimals();
            uint256 usd = Math.mulDiv(amountIn, price, unit);
            return Math.mulDiv(usd, _baseUnit, 1e18) * (BPS - spreadBps) / BPS;
        }
        revert InvalidPair();
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        override
        returns (uint256 amountOut)
    {
        amountOut = quoteOut(tokenIn, tokenOut, amountIn);
        if (amountOut < minOut) revert SlippageExceeded();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    function _setSpread(uint16 spreadBps_) internal {
        if (spreadBps_ > 500) revert SpreadTooHigh();
        spreadBps = spreadBps_;
    }
}
