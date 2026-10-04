// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice A brokerage position, denominated in shares of the stock that `asset` (a Robinhood stock token) represents.
struct Position {
    address asset;
    uint256 shares; // 1e18 = one share
}

/// @notice Holdings attestation signed by an approved broker (EIP-712).
struct Attestation {
    address facility;
    address borrower;
    bytes32 custodyRef; // salted hash of the brokerage account reference; no PII onchain
    Position[] positions;
    uint256 cashUsd; // 1e18
    uint256 encumberedUsd; // 1e18
    uint64 issuedAt;
    uint64 expiresAt;
    uint64 nonce;
}

enum AttStatus {
    NONE,
    VALID,
    STALE,
    REVOKED
}

/// @notice Risk level from the two signals (U, H), before attestation status and timers are applied.
enum Level {
    HEALTHY,
    WARNING,
    MARGIN_CALL,
    DELEVERAGING
}

/// @notice Effective facility state. DEFAULT means a resolution request has been emitted to the broker.
enum State {
    ACTIVE,
    WARNING,
    MARGIN_CALL,
    DELEVERAGING,
    FROZEN,
    CURE,
    DEFAULT,
    CLOSED
}

/// @notice Persisted lifecycle phase. Everything else is derived fresh on every call.
enum Phase {
    NORMAL,
    CURE,
    DEFAULT,
    CLOSED
}

/// @notice Fresh evaluation of a facility. All USD values are 1e18 fixed point.
struct Evaluation {
    State state;
    Level level;
    AttStatus att;
    uint256 debt;
    uint256 assets; // idle USDG + holdings at mark
    uint256 exposure; // max(0, debt - stressed assets): what the brokerage collateral must cover
    uint256 creditLimit;
    uint256 U; // exposure / creditLimit, 1e18 = 100%
    uint256 H; // assets / debt, 1e18 = 100%
    bool anyClosed; // at least one priced asset is in a closed market session
    bool degraded; // at least one closed-session asset has no fresh live price
}
