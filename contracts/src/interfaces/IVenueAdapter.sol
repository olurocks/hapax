// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Typed swap entry point. The facility never sends raw calldata to a venue.
interface IVenueAdapter {
    /// @notice Pulls `amountIn` of `tokenIn` from msg.sender and sends at least `minOut` of `tokenOut` to msg.sender.
    /// @dev The output recipient is always msg.sender. Callers must still measure balance deltas themselves.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut);
}
