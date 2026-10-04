// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "./Base.t.sol";
import {State} from "../src/libraries/Types.sol";
import {CreditFacility} from "../src/CreditFacility.sol";
import {RiskManager} from "../src/RiskManager.sol";

/// @notice The owner's side of a facility's life: repay from a wallet, take profits, cash out.
contract LifecycleTest is BaseTest {
    CreditFacility internal f;

    function setUp() public override {
        super.setUp();
        f = _open(alice);
        _attest(f, alice);
        vm.prank(alice);
        f.borrow(200_000e6);
    }

    function _appointAgent() internal {
        address[] memory tokens = new address[](1);
        tokens[0] = address(tsla);
        vm.prank(alice);
        f.setAgent(agent, uint64(block.timestamp + 1 days), 150_000e18, tokens);
    }

    /// Owner P&L = assets - debt - contributed + distributed (all in base units here).
    function _pnl() internal view returns (int256) {
        uint256 assets = _eval(f).assets / 1e12;
        uint256 debt = pool.debtOf(address(f));
        return int256(assets) - int256(debt) - int256(f.contributed()) + int256(f.distributed());
    }

    // ================================================================ repay from a wallet

    function test_repayFrom_walletPaysDebtDirectly() public {
        usdg.mint(alice, 50_000e6);
        vm.startPrank(alice);
        usdg.approve(address(f), type(uint256).max);
        uint256 paid = f.repayFrom(50_000e6);
        vm.stopPrank();

        assertEq(paid, 50_000e6);
        assertEq(pool.debtOf(address(f)), 150_000e6);
        assertEq(usdg.balanceOf(address(f)), 200_000e6); // the facility's own balance is untouched
        assertEq(f.contributed(), 50_000e6);
    }

    function test_repayFrom_cappedAtDebt() public {
        usdg.mint(bob, 500_000e6);
        vm.startPrank(bob); // anyone may repay on the owner's behalf
        usdg.approve(address(f), type(uint256).max);
        uint256 paid = f.repayFrom(500_000e6);
        vm.stopPrank();

        assertEq(paid, 200_000e6);
        assertEq(pool.debtOf(address(f)), 0);
        assertEq(usdg.balanceOf(bob), 300_000e6);
    }

    function test_repayFrom_worksWhileFrozen() public {
        vm.prank(broker);
        registry.revoke(address(f), 1);
        assertEq(uint8(_eval(f).state), uint8(State.FROZEN));

        usdg.mint(alice, 10_000e6);
        vm.startPrank(alice);
        usdg.approve(address(f), type(uint256).max);
        f.repayFrom(10_000e6);
        vm.stopPrank();
        assertEq(pool.debtOf(address(f)), 190_000e6);
    }

    // ================================================================ taking profits

    function test_withdrawProfit_afterAgentGain() public {
        _appointAgent();
        _buy(f, agent, address(tsla), 100_000e6);
        _setLive(address(tsla), 275e8); // +10%
        _marketOpenAt(address(tsla), 275e8);

        // Sell the winner, keep the debt: the surplus is the agent's profit.
        uint256 bal = tsla.balanceOf(address(f));
        vm.prank(agent);
        f.trade(address(venue), address(tsla), address(usdg), bal, 0);

        int256 pnl = _pnl();
        assertGt(pnl, 9_000e6);

        uint256 profit = uint256(pnl);
        vm.prank(alice);
        f.withdrawSurplus(profit, alice);
        assertEq(usdg.balanceOf(alice), profit);
        assertEq(f.distributed(), profit);
        assertApproxEqAbs(_pnl(), pnl, 1); // withdrawing doesn't change P&L, it realises it
    }

    function test_withdrawProfit_cannotTouchBorrowedFunds() public {
        _appointAgent();
        _buy(f, agent, address(tsla), 100_000e6);
        _setLive(address(tsla), 275e8);
        _marketOpenAt(address(tsla), 275e8);
        uint256 bal = tsla.balanceOf(address(f));
        vm.prank(agent);
        f.trade(address(venue), address(tsla), address(usdg), bal, 0);

        uint256 profit = uint256(_pnl());
        vm.prank(alice);
        vm.expectRevert();
        f.withdrawSurplus(profit + 1_000e6, alice);
    }

    // ================================================================ cash out

    function test_cashOut_sellsRepaysAndPaysOwner() public {
        _appointAgent();
        _buy(f, agent, address(tsla), 150_000e6);
        _setLive(address(tsla), 275e8);
        _marketOpenAt(address(tsla), 275e8);
        int256 pnl = _pnl();

        vm.prank(alice);
        uint256 paidOut = risk.cashOut(address(f), alice);

        assertEq(pool.debtOf(address(f)), 0);
        assertEq(tsla.balanceOf(address(f)), 0);
        assertEq(usdg.balanceOf(address(f)), 0);
        assertEq(usdg.balanceOf(alice), paidOut);
        assertApproxEqAbs(int256(paidOut), pnl, 200e6); // proceeds at live less the 10 bps venue spread
        assertEq(f.agent(), address(0)); // the agent loses its rights
        (,, bool active) = f.mandate();
        assertFalse(active);
        assertEq(uint8(_eval(f).state), uint8(State.ACTIVE));
    }

    function test_cashOut_onlyOwner() public {
        vm.prank(bob);
        vm.expectRevert(RiskManager.NotFacilityOwner.selector);
        risk.cashOut(address(f), bob);
    }

    function test_cashOut_revertsWhenSaleDoesNotCoverDebt_thenRepayFromWallet() public {
        _appointAgent();
        _buy(f, agent, address(tsla), 150_000e6);
        _setLive(address(tsla), 230e8); // -8%
        _marketOpenAt(address(tsla), 230e8);

        // Shortfall: holdings plus idle no longer cover the debt.
        vm.prank(alice);
        vm.expectRevert();
        risk.cashOut(address(f), alice);

        usdg.mint(alice, 20_000e6);
        vm.startPrank(alice);
        usdg.approve(address(f), type(uint256).max);
        f.repayFrom(20_000e6);
        uint256 paidOut = risk.cashOut(address(f), alice);
        vm.stopPrank();

        assertEq(pool.debtOf(address(f)), 0);
        assertGt(paidOut, 0);
        assertLt(_pnl(), 0); // a realised loss
    }

    function test_cashOut_blockedInDefault() public {
        vm.prank(broker);
        registry.revoke(address(f), 1);
        risk.poke(address(f));
        vm.warp(block.timestamp + 301);
        _refreshLive();
        risk.poke(address(f));
        assertEq(uint8(_eval(f).state), uint8(State.DEFAULT));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RiskManager.StateNotAllowed.selector, State.DEFAULT));
        risk.cashOut(address(f), alice);
    }

    function _marketOpenAt(address asset, int256 px) internal {
        refPx[asset] = px;
        livePx[asset] = px;
        _marketOpen();
    }
}
