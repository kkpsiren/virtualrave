"use client";
import { useState, useRef } from "react";
import { useAccount } from "wagmi";
import { Ticker } from "@/components/Ticker";
import { Nav } from "@/components/Nav";
import { Hero } from "@/components/Hero";
import { Strip } from "@/components/Strip";
import { ClaimSection } from "@/components/ClaimSection";
import { CollectorsWall } from "@/components/CollectorsWall";
import { CC0Guide } from "@/components/CC0Guide";
import { StudioSection } from "@/components/StudioSection";
import { MixtapeSection, useMixtapeAudio } from "@/components/Mixtape";
import { DropsRoadmap } from "@/components/DropsRoadmap";
import { EventsSection } from "@/components/EventsSection";
import { About } from "@/components/About";
import { Footer } from "@/components/Footer";
import { WalletModal } from "@/components/WalletModal";
import type { StudioBridge } from "@/components/Studio";
import type { OrbSession } from "@/components/OrbLoginPanel";

export default function Home() {
  const { address } = useAccount();
  const [showWallet, setShowWallet] = useState(false);
  const [orbSession, setOrbSession] = useState<OrbSession | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [mintTick, setMintTick] = useState(0);
  const bridgeRef = useRef<StudioBridge | null>(null);
  const mixtapeAudio = useMixtapeAudio();

  const walletShort = address ? `${address.slice(0, 6)}${address.slice(-4)}` : null;
  const onConnect = () => setShowWallet(true);

  return (
    <div className="page">
      <Ticker />
      <Nav
        onConnect={onConnect}
        walletShort={walletShort}
        playerOpen={playerOpen}
        togglePlayer={() => setPlayerOpen((o) => !o)}
        audio={mixtapeAudio}
      />
      <Hero />
      <Strip />
      <ClaimSection
        onConnect={onConnect}
        orbSession={orbSession}
        onMintSuccess={() => setMintTick((t) => t + 1)}
      />
      <CollectorsWall
        mintTick={mintTick}
        orbSession={orbSession}
        onConnect={onConnect}
      />
      <CC0Guide />
      <StudioSection bridgeRef={bridgeRef} />
      <MixtapeSection bridgeRef={bridgeRef} audio={mixtapeAudio} />
      <Strip alt />
      <DropsRoadmap />
      <EventsSection />
      <About />
      <Footer />
      {showWallet && (
        <WalletModal
          onClose={() => setShowWallet(false)}
          orbSession={orbSession}
          onOrbAuthenticated={setOrbSession}
          onOrbLogout={() => setOrbSession(null)}
        />
      )}
    </div>
  );
}
