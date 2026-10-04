// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IFacilityRegistry {
    function isFacility(address facility) external view returns (bool);
}

/// @title LiquidityPool
/// @notice Single-asset (USDG) lending pool for credit facilities. MVP: no pool shares; the owner is the lender.
/// Debt is tracked as scaled principal against a fixed-APR borrow index.
contract LiquidityPool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 public constant MAX_APR_BPS = 5_000;

    IERC20 public immutable asset;

    IFacilityRegistry public factory;
    address public riskManager;

    uint256 public borrowIndex = WAD;
    uint64 public lastAccrual;
    uint256 public ratePerSecond; // WAD
    uint16 public aprBps;

    uint256 public totalScaledDebt;
    mapping(address facility => uint256) public scaledDebtOf;
    uint256 public totalSupplied;
    uint256 public realizedLosses;

    event Supplied(address indexed lender, uint256 amount);
    event Withdrawn(address indexed lender, uint256 amount);
    event Borrowed(address indexed facility, uint256 amount, uint256 debtAfter);
    event Repaid(address indexed facility, address indexed payer, uint256 amount, uint256 debtAfter);
    event LossAbsorbed(address indexed facility, uint256 amount);
    event AprSet(uint16 aprBps);

    error AlreadySet();
    error NotFacility();
    error NotRiskManager();
    error InsufficientLiquidity();
    error ZeroAmount();
    error AprTooHigh();

    constructor(address owner_, IERC20 asset_, uint16 aprBps_) Ownable(owner_) {
        asset = asset_;
        lastAccrual = uint64(block.timestamp);
        _setApr(aprBps_);
    }

    // ---------------------------------------------------------------- admin

    function setFactory(address factory_) external onlyOwner {
        if (address(factory) != address(0)) revert AlreadySet();
        factory = IFacilityRegistry(factory_);
    }

    function setRiskManager(address riskManager_) external onlyOwner {
        if (riskManager != address(0)) revert AlreadySet();
        riskManager = riskManager_;
    }

    function setApr(uint16 aprBps_) external onlyOwner {
        accrue();
        _setApr(aprBps_);
    }

    // ---------------------------------------------------------------- lender

    function supply(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        totalSupplied += amount;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Supplied(msg.sender, amount);
    }

    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        if (amount > asset.balanceOf(address(this))) revert InsufficientLiquidity();
        totalSupplied = amount > totalSupplied ? 0 : totalSupplied - amount;
        asset.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------- facilities

    function borrow(uint256 amount) external nonReentrant {
        if (!factory.isFacility(msg.sender)) revert NotFacility();
        if (amount == 0) revert ZeroAmount();
        if (amount > asset.balanceOf(address(this))) revert InsufficientLiquidity();
        accrue();
        uint256 scaled = Math.mulDiv(amount, WAD, borrowIndex, Math.Rounding.Ceil);
        scaledDebtOf[msg.sender] += scaled;
        totalScaledDebt += scaled;
        asset.safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount, debtOf(msg.sender));
    }

    /// @notice Repay `amount` (capped at outstanding debt) of `facility`'s debt, pulled from msg.sender.
    function repay(address facility, uint256 amount) external nonReentrant returns (uint256 paid) {
        accrue();
        uint256 debt = debtOf(facility);
        paid = amount < debt ? amount : debt;
        if (paid == 0) return 0;
        uint256 scaled = paid == debt
            ? scaledDebtOf[facility]
            : Math.mulDiv(paid, WAD, borrowIndex, Math.Rounding.Floor);
        scaledDebtOf[facility] -= scaled;
        totalScaledDebt -= scaled;
        asset.safeTransferFrom(msg.sender, address(this), paid);
        emit Repaid(facility, msg.sender, paid, debtOf(facility));
    }

    /// @notice Write off whatever debt remains after settlement.
    function absorbLoss(address facility) external returns (uint256 loss) {
        if (msg.sender != riskManager) revert NotRiskManager();
        accrue();
        loss = debtOf(facility);
        totalScaledDebt -= scaledDebtOf[facility];
        scaledDebtOf[facility] = 0;
        realizedLosses += loss;
        emit LossAbsorbed(facility, loss);
    }

    // ---------------------------------------------------------------- accounting

    function accrue() public {
        borrowIndex = currentIndex();
        lastAccrual = uint64(block.timestamp);
    }

    function currentIndex() public view returns (uint256) {
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0 || ratePerSecond == 0) return borrowIndex;
        return borrowIndex + Math.mulDiv(borrowIndex, ratePerSecond * dt, WAD);
    }

    /// @notice Outstanding debt in asset units, rounded up.
    function debtOf(address facility) public view returns (uint256) {
        return Math.mulDiv(scaledDebtOf[facility], currentIndex(), WAD, Math.Rounding.Ceil);
    }

    function totalDebt() public view returns (uint256) {
        return Math.mulDiv(totalScaledDebt, currentIndex(), WAD, Math.Rounding.Ceil);
    }

    function cash() external view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function totalAssets() external view returns (uint256) {
        return asset.balanceOf(address(this)) + totalDebt();
    }

    function utilizationBps() external view returns (uint256) {
        uint256 d = totalDebt();
        uint256 total = d + asset.balanceOf(address(this));
        return total == 0 ? 0 : d * 10_000 / total;
    }

    function _setApr(uint16 aprBps_) internal {
        if (aprBps_ > MAX_APR_BPS) revert AprTooHigh();
        aprBps = aprBps_;
        ratePerSecond = uint256(aprBps_) * WAD / 10_000 / 365 days;
        emit AprSet(aprBps_);
    }
}
