// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @title DemoFeed
/// @notice Operator-controlled AggregatorV3 feed for testnet demos. Robinhood Chain's testnet stock feeds are
/// mocks too; this one lets the demo "close the market" and "crash TSLA on Saturday" on cue.
/// The UI badges every asset priced by a DemoFeed. Mainnet uses Chainlink feeds only.
contract DemoFeed is AggregatorV3Interface, Ownable {
    uint8 public immutable override decimals;
    string public override description;

    uint80 internal _roundId;
    int256 internal _answer;
    uint256 internal _updatedAt;

    event AnswerUpdated(int256 answer, uint256 updatedAt, uint80 roundId);

    constructor(address owner_, string memory description_, uint8 decimals_, int256 initialAnswer)
        Ownable(owner_)
    {
        description = description_;
        decimals = decimals_;
        _set(initialAnswer, block.timestamp);
    }

    /// @notice Publish a fresh price (market open, or a live weekend trade).
    function setAnswer(int256 answer) external onlyOwner {
        _set(answer, block.timestamp);
    }

    /// @notice Publish a price with an explicit timestamp, e.g. backdate to Friday's close.
    function setRoundData(int256 answer, uint256 updatedAt) external onlyOwner {
        _set(answer, updatedAt);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function _set(int256 answer, uint256 updatedAt) internal {
        _roundId++;
        _answer = answer;
        _updatedAt = updatedAt;
        emit AnswerUpdated(answer, updatedAt, _roundId);
    }
}
