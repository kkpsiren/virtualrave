"use client";
import { useConnect } from "wagmi";
import { OrbLoginPanel, type OrbSession } from "./OrbLoginPanel";

interface WalletModalProps {
  onClose: () => void;
  orbSession: OrbSession | null;
  onOrbAuthenticated: (session: OrbSession) => void;
  onOrbLogout: () => void;
  orbSessionExpired?: boolean;
}

export function WalletModal({
  onClose,
  orbSession,
  onOrbAuthenticated,
  onOrbLogout,
  orbSessionExpired = false,
}: WalletModalProps) {
  const { connect, connectors } = useConnect();
  const isMobile =
    typeof navigator !== "undefined" &&
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  const openZerion = (uri: string) => {
    const deeplink = `zerion://wc?uri=${encodeURIComponent(uri)}`;
    window.location.assign(deeplink);
  };

  const connectWithMobileWalletConnect = async (connector: (typeof connectors)[number]) => {
    const onMessage = (message: { uid: string; type: string; data?: unknown }) => {
      if (message.type !== "display_uri" || typeof message.data !== "string") return;
      openZerion(message.data);
    };

    connector.emitter.on("message", onMessage);
    try {
      const connection = connect({ connector });
      onClose();
      await connection;
    } finally {
      connector.emitter.off("message", onMessage);
    }
  };

  const renderConnectorIcon = (connector: (typeof connectors)[number]) => {
    if (connector.icon) {
      return <img className="wallet-icon" src={connector.icon} alt="" aria-hidden="true" />;
    }

    const label =
      connector.id === "walletConnect"
        ? "WC"
        : connector.name
            .split(/\s+/)
            .map((part) => part[0])
            .join("")
            .slice(0, 2)
            .toUpperCase();

    return <span className="wallet-fallback">{label}</span>;
  };

  const handleConnectorClick = (connector: (typeof connectors)[number]) => {
    if (isMobile && connector.id === "walletConnect") {
      void connectWithMobileWalletConnect(connector);
      return;
    }

    void connect({ connector });
    onClose();
  };

  const walletConnectConnector = connectors.find((connector) => connector.id === "walletConnect") ?? null;

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="win__bar">
          <div className="title">
            <span className="ico"></span> connect_wallet.dlg
          </div>
          <div className="ctrls">
            <span className="ctrl" onClick={onClose}>
              
            </span>
          </div>
        </div>
        <OrbLoginPanel
          session={orbSession}
          onAuthenticated={onOrbAuthenticated}
          onLogout={onOrbLogout}
          onAuthSuccess={onClose}
          sessionExpired={orbSessionExpired}
        />
        <div className="modal__label">
          then choose your wallet. on mobile, walletconnect can hand off to zerion.
        </div>
        {isMobile && walletConnectConnector && (
          <div
            className="opt modal__zerion"
            onClick={() => handleConnectorClick(walletConnectConnector)}
          >
            <span className="name">
              <span className="ic modal__zerion-ic" aria-hidden="true">
                Z
              </span>
              Zerion Wallet
            </span>
            <span className="arr"></span>
          </div>
        )}
        <div className="modal__wallets">
          {connectors.map((connector) => (
            <div
              key={connector.uid}
              className="opt"
              onClick={() => handleConnectorClick(connector)}
            >
              <span className="name">
                <span className="ic">
                  {renderConnectorIcon(connector)}
                </span>
                {connector.name}
              </span>
              <span className="arr"></span>
            </div>
          ))}
        </div>
        <div className="modal__foot">
          <span>CHECK THE WALLET PROMPT BEFORE YOU SIGN</span>
          <span>LENS  CHAIN 232</span>
        </div>
      </div>
    </div>
  );
}
