// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "./Base.t.sol";
import {Attestation, AttStatus, Evaluation, Position, State} from "../src/libraries/Types.sol";
import {CollateralRegistry} from "../src/CollateralRegistry.sol";
import {CreditFacility} from "../src/CreditFacility.sol";
import {RiskManager} from "../src/RiskManager.sol";

/// @notice One test per demo scene (docs/ARCHITECTURE.md section 16), plus the guardrails around them.
contract ScenariosTest is BaseTest {
    CreditFacility internal f;

    function setUp() public override {
        super.setUp();
        f = _open(alice);
        _attest(f, alice);
    }

    // ================================================================ scene 1: Friday, market open

    function test_creditLimit_marketOpen() public view {
        Evaluation memory e = _eval(f);
        // (250k + 100k) * 0.75 + 50k = 312.5k eligible, * 0.80 = 250k
        assertEq(e.creditLimit, 250_000e18);
        assertEq(uint8(e.state), uint8(State.ACTIVE));
        assertEq(uint8(e.att), uint8(AttStatus.VALID));
        assertFalse(e.anyClosed);
    }

    // ================================================================ scene 2: borrow, trade, policy rejections

    function test_borrowAndBuy() public {
        vm.prank(alice);
        f.borrow(300_000e6);
        assertEq(_eval(f).U, 0); // idle USDG in the facility is not at risk

        uint256 got = _buy(f, alice, address(tsla), 300_000e6);
        assertApproxEqAbs(got, 1_198.8e18, 1e15); // 300k / 250 minus 10 bps spread
        Evaluation memory e = _eval(f);
        assertEq(uint8(e.state), uint8(State.ACTIVE));
        // exposure = 300k - 299.7k * 0.75 = 75.2k; U = 75.2k / 250k
        assertApproxEqAbs(e.exposure, 75_225e18, 1e18);
        assertApproxEqAbs(e.U, 0.3009e18, 1e14);
        assertApproxEqAbs(e.H, 0.999e18, 1e15);
    }

    /// Same $400k account: cash-out credit would stop at 70% of the $250k limit ($175k).
    /// Because borrowed USDG never leaves the facility, the collateral only backs the stressed loss.
    function test_buyingPower_isExposureBased() public {
        assertEq(risk.buyingPower(address(f)), 700_000e6); // 175k / 25% haircut

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RiskManager.ExceedsCredit.selector, 175_000.25e18, 175_000e18));
        f.borrow(700_001e6);

        vm.prank(alice);
        f.borrow(700_000e6);
    }

    function test_buyingPower_shrinksWhenMarketCloses() public {
        _marketClose();
        assertEq(risk.buyingPower(address(f)), 364_000e6); // 208k * 0.7 / 40% weekend haircut
    }

    function test_buy_enforcesInitialMargin() public {
        vm.prank(alice);
        f.borrow(700_000e6);
        // Fully investing costs the 10 bps spread, which pushes exposure just past the 70% initial margin.
        vm.prank(alice);
        vm.expectRevert();
        f.trade(address(venue), address(usdg), address(tsla), 700_000e6, 0);

        _buy(f, alice, address(tsla), 680_000e6);
    }

    function test_policy_rejectsUnlistedAdapter() public {
        vm.prank(alice);
        f.borrow(10_000e6);
        address rogue = makeAddr("rogue");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RiskManager.AdapterNotAllowed.selector, rogue));
        f.trade(rogue, address(usdg), address(tsla), 1_000e6, 0);
    }

    function test_policy_rejectsWithdrawingBorrowedFunds() public {
        vm.prank(alice);
        f.borrow(10_000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RiskManager.NotSurplus.selector, 1e18, 0));
        f.withdrawSurplus(1e6, alice);
    }

    // ================================================================ the agent mandate

    function _appointAgent() internal {
        address[] memory tokens = new address[](2);
        tokens[0] = address(tsla);
        tokens[1] = address(nflx);
        vm.prank(alice);
        f.setAgent(agent, uint64(block.timestamp + 1 days), 50_000e18, tokens);
    }

    function test_agent_tradesWithinMandate() public {
        vm.prank(alice);
        f.borrow(200_000e6);
        _appointAgent();

        _buy(f, agent, address(nflx), 20_000e6);
        _buy(f, agent, address(tsla), 45_000e6);
        assertGt(nflx.balanceOf(address(f)), 0);
        assertGt(tsla.balanceOf(address(f)), 0);
    }

    function test_agent_cannotBuyOutsideMandate() public {
        vm.prank(alice);
        f.borrow(200_000e6);
        _appointAgent();

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CreditFacility.OutsideMandate.selector, address(amzn)));
        f.trade(address(venue), address(usdg), address(amzn), 10_000e6, 0);
    }

    function test_agent_positionCapEnforced() public {
        vm.prank(alice);
        f.borrow(200_000e6);
        _appointAgent();

        _buy(f, agent, address(nflx), 40_000e6);
        vm.prank(agent);
        vm.expectRevert(); // PositionTooLarge: ~60k NFLX > 50k mandate cap
        f.trade(address(venue), address(usdg), address(nflx), 20_000e6, 0);

        // The owner is only bound by the global cap.
        _buy(f, alice, address(nflx), 20_000e6);
    }

    function test_agent_neverGetsKeys() public {
        vm.prank(alice);
        f.borrow(200_000e6);
        _appointAgent();

        vm.startPrank(agent);
        vm.expectRevert(CreditFacility.Unauthorized.selector);
        f.borrow(1e6);
        vm.expectRevert(CreditFacility.Unauthorized.selector);
        f.withdrawSurplus(1e6, agent);
        vm.expectRevert(CreditFacility.Unauthorized.selector);
        f.setAgent(agent, type(uint64).max, 0, new address[](0));
        vm.stopPrank();
    }

    function test_agent_maySellAnything() public {
        vm.prank(alice);
        f.borrow(200_000e6);
        _buy(f, alice, address(amzn), 10_000e6); // owner buys something outside the mandate
        _appointAgent();

        uint256 bal = amzn.balanceOf(address(f));
        vm.prank(agent);
        f.trade(address(venue), address(amzn), address(usdg), bal, 0);
        assertEq(amzn.balanceOf(address(f)), 0);
    }

    function test_agent_killSwitchAndExpiry() public {
        vm.prank(alice);
        f.borrow(200_000e6);
        _appointAgent();

        vm.prank(alice);
        f.revokeAgent();
        vm.prank(agent);
        vm.expectRevert(CreditFacility.Unauthorized.selector);
        f.trade(address(venue), address(usdg), address(tsla), 1_000e6, 0);

        _appointAgent();
        vm.warp(block.timestamp + 1 days);
        _marketOpen();
        vm.prank(agent);
        vm.expectRevert(CreditFacility.Unauthorized.selector);
        f.trade(address(venue), address(usdg), address(tsla), 1_000e6, 0);
    }

    // ================================================================ scene 3: Friday close

    function test_marketClose_shrinksLimitWithoutTransaction() public {
        vm.prank(alice);
        f.borrow(300_000e6);
        _buy(f, alice, address(tsla), 300_000e6);

        _marketClose();
        Evaluation memory e = _eval(f);
        // (250k + 100k) * 0.60 + 50k = 260k eligible, * 0.80 = 208k
        // exposure = 300k - 299.7k * 0.60 = 120.2k; U = 120.2k / 208k
        assertTrue(e.anyClosed);
        assertEq(e.creditLimit, 208_000e18);
        assertApproxEqAbs(e.U, 0.5778e18, 1e15);
        assertEq(uint8(e.state), uint8(State.ACTIVE));
    }

    function test_weekendPump_doesNotRaiseLimit() public {
        _marketClose();
        _setLive(address(tsla), 300e8); // +20% onchain on Saturday
        assertEq(_eval(f).creditLimit, 208_000e18);
    }

    function test_openSession_deviationUsesConservativeMark() public {
        _setLive(address(tsla), 200e8); // live 20% below reference while the market is open
        // TSLA marked at 200: (200k + 100k) * 0.75 + 50k = 275k, * 0.8 = 220k
        assertEq(_eval(f).creditLimit, 220_000e18);
    }

    function test_closedAndLiveStale_isDegraded_blocksBorrow() public {
        vm.warp(block.timestamp + REF_HEARTBEAT + LIVE_MAX_AGE + 1);
        assertTrue(_eval(f).degraded);
        vm.prank(alice);
        vm.expectRevert(RiskManager.PriceDegraded.selector);
        f.borrow(1_000e6);
    }

    // ================================================================ scene 4: Saturday crash, deleverage, cure

    function test_saturdayCrash_walksStatesAndDeleverages() public {
        vm.prank(alice);
        f.borrow(300_000e6);
        _buy(f, alice, address(tsla), 300_000e6);
        _marketClose();

        _setLive(address(tsla), 235e8); // -6%
        assertEq(uint8(risk.poke(address(f))), uint8(State.WARNING));

        _setLive(address(tsla), 222.5e8); // -11%
        assertEq(uint8(risk.poke(address(f))), uint8(State.MARGIN_CALL));

        // No new risk in MARGIN_CALL, but reducing is allowed.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RiskManager.StateNotAllowed.selector, State.MARGIN_CALL));
        f.trade(address(venue), address(usdg), address(nflx), 1e6, 0);

        _setLive(address(tsla), 210e8); // -16%
        Evaluation memory e = _eval(f);
        assertEq(uint8(e.state), uint8(State.DELEVERAGING));
        assertLt(e.H, 0.85e18);
        assertTrue(risk.canDeleverage(address(f)));

        vm.prank(keeper);
        uint256 residual = risk.deleverage(address(f));

        assertEq(tsla.balanceOf(address(f)), 0);
        assertGt(usdg.balanceOf(keeper), 0);
        assertGt(residual, 45_000e6);
        assertLt(residual, 55_000e6);
        assertEq(uint8(_eval(f).state), uint8(State.CURE));
    }

    function test_deleverage_notAllowedWhenHealthy() public {
        vm.prank(alice);
        f.borrow(100_000e6);
        vm.expectRevert(abi.encodeWithSelector(RiskManager.CannotDeleverage.selector, State.ACTIVE));
        risk.deleverage(address(f));
    }

    function test_cure_byRepayingResidual() public {
        uint256 residual = _crashAndDeleverage();
        usdg.mint(alice, residual + 1e6);
        vm.startPrank(alice);
        usdg.approve(address(f), type(uint256).max);
        f.deposit(residual + 1e6);
        f.repay(type(uint256).max);
        vm.stopPrank();

        assertEq(pool.debtOf(address(f)), 0);
        assertEq(uint8(risk.poke(address(f))), uint8(State.ACTIVE));
    }

    // ================================================================ scene 5: revocation

    function test_revocation_freezesInSameBlock() public {
        vm.prank(alice);
        f.borrow(50_000e6);
        _buy(f, alice, address(tsla), 20_000e6);

        vm.prank(broker);
        registry.revoke(address(f), 1);

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(RiskManager.StateNotAllowed.selector, State.FROZEN));
        f.borrow(1_000e6);
        vm.expectRevert(abi.encodeWithSelector(RiskManager.StateNotAllowed.selector, State.FROZEN));
        f.trade(address(venue), address(usdg), address(tsla), 1_000e6, 0);

        // Reduce and repay still work.
        uint256 bal = tsla.balanceOf(address(f));
        f.trade(address(venue), address(tsla), address(usdg), bal, 0);
        f.repay(10_000e6);
        vm.stopPrank();
    }

    function test_staleAttestation_freezes() public {
        vm.prank(alice);
        f.borrow(10_000e6);
        vm.warp(block.timestamp + 1 days);
        _marketOpen();
        assertEq(uint8(_eval(f).att), uint8(AttStatus.STALE));
        assertEq(uint8(_eval(f).state), uint8(State.FROZEN));
    }

    function test_frozen_forceReducedOnlyAfterGrace() public {
        vm.prank(alice);
        f.borrow(50_000e6);
        _buy(f, alice, address(tsla), 50_000e6);
        vm.prank(broker);
        registry.revoke(address(f), 1);
        risk.poke(address(f));

        vm.expectRevert(abi.encodeWithSelector(RiskManager.CannotDeleverage.selector, State.FROZEN));
        risk.deleverage(address(f));

        vm.warp(block.timestamp + 121);
        _marketOpen();
        risk.deleverage(address(f));
        assertEq(tsla.balanceOf(address(f)), 0);
    }

    function test_freshAttestation_unfreezes() public {
        vm.prank(broker);
        registry.revoke(address(f), 1);
        assertEq(uint8(_eval(f).state), uint8(State.FROZEN));
        _attest(f, alice);
        assertEq(uint8(_eval(f).state), uint8(State.ACTIVE));
    }

    // ================================================================ scene 6: default and settlement

    function test_cureLapse_default_settlement_closes() public {
        uint256 residual = _crashAndDeleverage();
        vm.warp(block.timestamp + 121);
        _refreshLive();

        vm.expectEmit(true, false, false, false, address(risk));
        emit RiskManager.ResolutionRequested(address(f), 0, bytes32(0));
        assertEq(uint8(risk.poke(address(f))), uint8(State.DEFAULT));

        uint256 debt = pool.debtOf(address(f));
        assertGe(debt, residual);
        usdg.mint(broker, debt);
        vm.startPrank(broker);
        usdg.approve(address(risk), debt);
        risk.confirmSettlement(address(f), debt, keccak256("sale-receipt"));
        vm.stopPrank();

        assertEq(pool.debtOf(address(f)), 0);
        assertEq(pool.realizedLosses(), 0);
        assertEq(uint8(_eval(f).state), uint8(State.CLOSED));
    }

    function test_settlementShortfall_isAbsorbed() public {
        _crashAndDeleverage();
        vm.warp(block.timestamp + 121);
        _refreshLive();
        risk.poke(address(f));

        usdg.mint(broker, 5_000e6);
        vm.startPrank(broker);
        usdg.approve(address(risk), 5_000e6);
        risk.confirmSettlement(address(f), 5_000e6, keccak256("partial"));
        vm.stopPrank();

        assertGt(pool.realizedLosses(), 0);
        assertEq(pool.debtOf(address(f)), 0);
    }

    // ================================================================ attestation guardrails

    function test_attestation_replayRejected() public {
        Attestation memory a = _attestation(f, alice, nonce); // same nonce as the accepted one
        bytes memory sig = _sign(brokerPk, a);
        vm.expectRevert(CollateralRegistry.StaleNonce.selector);
        registry.submit(a, sig);
    }

    function test_attestation_unknownSignerRejected() public {
        Attestation memory a = _attestation(f, alice, nonce + 1);
        bytes memory sig = _sign(0xBAD, a);
        vm.expectRevert(CollateralRegistry.NotBroker.selector);
        registry.submit(a, sig);
    }

    function test_attestation_borrowerMustOwnFacility() public {
        Attestation memory a = _attestation(f, bob, nonce + 1);
        bytes memory sig = _sign(brokerPk, a);
        vm.expectRevert(CollateralRegistry.BorrowerMismatch.selector);
        registry.submit(a, sig);
    }

    function test_encumbrance_reducesLimit() public {
        Position[] memory ps = new Position[](2);
        ps[0] = Position(address(tsla), 1_000e18);
        ps[1] = Position(address(amzn), 500e18);
        _attestWith(f, alice, ps, 50_000e18, 100_000e18, 1 days);
        // 312.5k - 100k = 212.5k eligible, * 0.8 = 170k
        assertEq(_eval(f).creditLimit, 170_000e18);
    }

    // ================================================================ the demo video storyline (docs section 16)

    /// Draw $300k, mandate cap $250k: the agent's oversize buy is refused, its $250k buy fills with $50k left idle,
    /// so every later refusal reaches the contract. Weekend crash levels: WARNING -6%, MARGIN_CALL -12%, keeper -18%.
    function test_demoStoryline() public {
        vm.prank(alice);
        f.borrow(300_000e6);
        address[] memory tokens = new address[](2);
        tokens[0] = address(tsla);
        tokens[1] = address(nflx);
        vm.prank(alice);
        f.setAgent(agent, uint64(block.timestamp + 1 days), 250_000e18, tokens);

        // Oversize: $280k of TSLA is over the $250k mandate cap.
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(RiskManager.PositionTooLarge.selector, address(tsla), 279_720e18));
        f.trade(address(venue), address(usdg), address(tsla), 280_000e6, 0);

        // Off-mandate.
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(CreditFacility.OutsideMandate.selector, address(amzn)));
        f.trade(address(venue), address(usdg), address(amzn), 10_000e6, 0);

        _buy(f, agent, address(tsla), 250_000e6);
        assertEq(usdg.balanceOf(address(f)), 50_000e6);

        _marketClose();
        _setLive(address(tsla), 235e8); // -6%
        assertEq(uint8(risk.poke(address(f))), uint8(State.WARNING));
        _setLive(address(tsla), 220e8); // -12%
        assertEq(uint8(risk.poke(address(f))), uint8(State.MARGIN_CALL));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(RiskManager.StateNotAllowed.selector, State.MARGIN_CALL));
        f.trade(address(venue), address(usdg), address(nflx), 25_000e6, 0);

        _setLive(address(tsla), 205e8); // -18%
        assertEq(uint8(_eval(f).state), uint8(State.DELEVERAGING));
        vm.prank(keeper);
        uint256 residual = risk.deleverage(address(f));
        assertGt(residual, 44_000e6);
        assertLt(residual, 48_000e6);
        assertEq(uint8(_eval(f).state), uint8(State.CURE));
    }

    // ================================================================ helpers

    function _crashAndDeleverage() internal returns (uint256 residual) {
        vm.prank(alice);
        f.borrow(300_000e6);
        _buy(f, alice, address(tsla), 300_000e6);
        _marketClose();
        _setLive(address(tsla), 210e8);
        vm.prank(keeper);
        residual = risk.deleverage(address(f));
    }

    function _attestation(CreditFacility fac, address borrower, uint64 n) internal view returns (Attestation memory) {
        Position[] memory ps = new Position[](1);
        ps[0] = Position(address(tsla), 1_000e18);
        return Attestation({
            facility: address(fac),
            borrower: borrower,
            custodyRef: keccak256(abi.encode("acct", alice)),
            positions: ps,
            cashUsd: 0,
            encumberedUsd: 0,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + 1 hours,
            nonce: n
        });
    }
}
