// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Attestation, AttStatus, Position} from "./libraries/Types.sol";
import {MarketOracle} from "./MarketOracle.sol";

interface IFacilityOwner {
    function owner() external view returns (address);
}

interface IFacilityDirectory {
    function isFacility(address facility) external view returns (bool);
}

/// @title CollateralRegistry
/// @notice Verifies and stores broker-signed holdings attestations. The broker attests what the borrower holds
/// (shares per stock); the RiskManager decides what it is worth right now.
contract CollateralRegistry is Ownable, EIP712 {
    struct Record {
        address broker;
        bytes32 custodyRef;
        uint256 cashUsd;
        uint256 encumberedUsd;
        uint64 issuedAt;
        uint64 expiresAt;
        uint64 nonce;
        bool revoked;
        uint8 revokeReason;
    }

    bytes32 public constant POSITION_TYPEHASH = keccak256("Position(address asset,uint256 shares)");
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(address facility,address borrower,bytes32 custodyRef,Position[] positions,uint256 cashUsd,uint256 encumberedUsd,uint64 issuedAt,uint64 expiresAt,uint64 nonce)Position(address asset,uint256 shares)"
    );

    uint256 public constant MAX_POSITIONS = 8;
    uint64 public constant MAX_CLOCK_SKEW = 60;

    MarketOracle public immutable oracle;
    IFacilityDirectory public factory;
    uint64 public maxTtl;

    mapping(address broker => bool) public isBroker;
    mapping(address facility => Record) internal _records;
    mapping(address facility => Position[]) internal _positions;

    event BrokerSet(address indexed broker, bool approved);
    event MaxTtlSet(uint64 maxTtl);
    event AttestationAccepted(
        address indexed facility, address indexed broker, uint64 nonce, uint64 expiresAt, bytes32 custodyRef
    );
    event AttestationRevoked(address indexed facility, address indexed by, uint8 reasonCode);

    error FactoryAlreadySet();
    error NotBroker();
    error NotFacility();
    error BorrowerMismatch();
    error CustodyRefMismatch();
    error BrokerMismatch();
    error StaleNonce();
    error BadTimestamps();
    error TooManyPositions();
    error UnknownAsset(address asset);
    error NoAttestation();

    constructor(address owner_, MarketOracle oracle_, uint64 maxTtl_) Ownable(owner_) EIP712("Hapax", "1") {
        oracle = oracle_;
        maxTtl = maxTtl_;
    }

    // ---------------------------------------------------------------- admin

    function setFactory(address factory_) external onlyOwner {
        if (address(factory) != address(0)) revert FactoryAlreadySet();
        factory = IFacilityDirectory(factory_);
    }

    function setBroker(address broker, bool approved) external onlyOwner {
        isBroker[broker] = approved;
        emit BrokerSet(broker, approved);
    }

    function setMaxTtl(uint64 maxTtl_) external onlyOwner {
        if (maxTtl_ == 0 || maxTtl_ > 7 days) revert BadTimestamps();
        maxTtl = maxTtl_;
        emit MaxTtlSet(maxTtl_);
    }

    // ---------------------------------------------------------------- attestations

    /// @notice Submit a broker-signed attestation. Anyone may relay it; only the signature matters.
    function submit(Attestation calldata a, bytes calldata signature) external {
        address signer = ECDSA.recover(_hashTypedDataV4(hashAttestation(a)), signature);
        if (!isBroker[signer]) revert NotBroker();
        if (!factory.isFacility(a.facility)) revert NotFacility();
        if (IFacilityOwner(a.facility).owner() != a.borrower) revert BorrowerMismatch();

        Record storage r = _records[a.facility];
        if (r.broker != address(0)) {
            if (r.broker != signer) revert BrokerMismatch();
            if (r.custodyRef != a.custodyRef) revert CustodyRefMismatch();
            if (a.nonce <= r.nonce) revert StaleNonce();
        }
        if (
            a.issuedAt > block.timestamp + MAX_CLOCK_SKEW || a.expiresAt <= block.timestamp
                || a.expiresAt <= a.issuedAt || a.expiresAt - a.issuedAt > maxTtl
        ) revert BadTimestamps();
        if (a.positions.length > MAX_POSITIONS) revert TooManyPositions();

        delete _positions[a.facility];
        for (uint256 i; i < a.positions.length; ++i) {
            if (!oracle.isRegistered(a.positions[i].asset)) revert UnknownAsset(a.positions[i].asset);
            _positions[a.facility].push(a.positions[i]);
        }

        r.broker = signer;
        r.custodyRef = a.custodyRef;
        r.cashUsd = a.cashUsd;
        r.encumberedUsd = a.encumberedUsd;
        r.issuedAt = a.issuedAt;
        r.expiresAt = a.expiresAt;
        r.nonce = a.nonce;
        r.revoked = false;
        r.revokeReason = 0;

        emit AttestationAccepted(a.facility, signer, a.nonce, a.expiresAt, a.custodyRef);
    }

    /// @notice The attesting broker (or the admin as guardian) revokes. Takes effect in the same block.
    function revoke(address facility, uint8 reasonCode) external {
        Record storage r = _records[facility];
        if (r.broker == address(0)) revert NoAttestation();
        if (msg.sender != r.broker && msg.sender != owner()) revert NotBroker();
        r.revoked = true;
        r.revokeReason = reasonCode;
        emit AttestationRevoked(facility, msg.sender, reasonCode);
    }

    // ---------------------------------------------------------------- views

    function status(address facility) public view returns (AttStatus) {
        Record storage r = _records[facility];
        if (r.broker == address(0)) return AttStatus.NONE;
        if (r.revoked) return AttStatus.REVOKED;
        if (block.timestamp >= r.expiresAt) return AttStatus.STALE;
        return AttStatus.VALID;
    }

    function record(address facility) external view returns (Record memory) {
        return _records[facility];
    }

    function positions(address facility) external view returns (Position[] memory) {
        return _positions[facility];
    }

    function brokerOf(address facility) external view returns (address) {
        return _records[facility].broker;
    }

    function hashAttestation(Attestation calldata a) public pure returns (bytes32) {
        bytes32[] memory posHashes = new bytes32[](a.positions.length);
        for (uint256 i; i < a.positions.length; ++i) {
            posHashes[i] = keccak256(abi.encode(POSITION_TYPEHASH, a.positions[i].asset, a.positions[i].shares));
        }
        return keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                a.facility,
                a.borrower,
                a.custodyRef,
                keccak256(abi.encodePacked(posHashes)),
                a.cashUsd,
                a.encumberedUsd,
                a.issuedAt,
                a.expiresAt,
                a.nonce
            )
        );
    }

    function digest(Attestation calldata a) external view returns (bytes32) {
        return _hashTypedDataV4(hashAttestation(a));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
