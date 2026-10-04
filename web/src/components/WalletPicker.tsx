import { useState } from "react";
import type { DiscoveredWallet } from "../lib/wallet";
import { revertReason } from "../lib/chain";
import { Modal } from "./Modal";

export function WalletPicker({
  wallets,
  onPick,
  onClose,
}: {
  wallets: DiscoveredWallet[];
  onPick: (w: DiscoveredWallet) => Promise<void>;
  onClose: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (w: DiscoveredWallet) => {
    setPending(w.info.uuid);
    setError(null);
    try {
      await onPick(w);
      onClose();
    } catch (err) {
      setError(revertReason(err));
    } finally {
      setPending(null);
    }
  };
  return (
    <Modal title="Connect a wallet" onClose={onClose}>
      {wallets.length === 0 ? (
        <>
          <p className="note">No browser wallet found. Install one to use Hapax, then reload this page.</p>
          <div className="actions">
            <a className="button primary" href="https://metamask.io/download/" target="_blank" rel="noreferrer">Get MetaMask</a>
            <a className="button" href="https://rabby.io/" target="_blank" rel="noreferrer">Get Rabby</a>
          </div>
        </>
      ) : (
        <ul className="walletlist">
          {wallets.map((w) => (
            <li key={w.info.uuid}>
              <button disabled={!!pending} onClick={() => pick(w)}>
                {w.info.icon ? <img src={w.info.icon} alt="" width={28} height={28} /> : <span className="wicon" aria-hidden="true" />}
                <span>{w.info.name}</span>
                <span className="label">{pending === w.info.uuid ? "Check your wallet…" : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="txerr">{error}</p>}
      <p className="note fine">Hapax never holds your keys. Connecting shares your address; every action asks your wallet first.</p>
    </Modal>
  );
}
