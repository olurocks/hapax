// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreditFacility} from "./CreditFacility.sol";
import {LiquidityPool} from "./LiquidityPool.sol";

/// @title FacilityFactory
/// @notice Deploys per-borrower CreditFacility clones and keeps the list the keeper iterates.
/// Production would gate `openFacility` to onboarded borrowers; the testnet demo is open.
contract FacilityFactory {
    address public immutable implementation;
    address public immutable risk;
    LiquidityPool public immutable pool;
    IERC20 public immutable base;

    mapping(address => bool) public isFacility;
    mapping(address owner => address[]) internal _facilitiesOf;
    address[] internal _facilities;

    event FacilityOpened(address indexed facility, address indexed owner);

    constructor(address risk_, LiquidityPool pool_, IERC20 base_) {
        implementation = address(new CreditFacility());
        risk = risk_;
        pool = pool_;
        base = base_;
    }

    function openFacility() external returns (address facility) {
        facility = Clones.clone(implementation);
        CreditFacility(facility).initialize(msg.sender, risk, pool, base);
        isFacility[facility] = true;
        _facilities.push(facility);
        _facilitiesOf[msg.sender].push(facility);
        emit FacilityOpened(facility, msg.sender);
    }

    function facilities() external view returns (address[] memory) {
        return _facilities;
    }

    function facilitiesOf(address owner) external view returns (address[] memory) {
        return _facilitiesOf[owner];
    }

    function facilityCount() external view returns (uint256) {
        return _facilities.length;
    }
}
