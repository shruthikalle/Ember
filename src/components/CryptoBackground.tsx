'use client';

import { useRef, useMemo, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, MeshDistortMaterial } from '@react-three/drei';
import * as THREE from 'three';

/* ═══════════════════════════════════════════════════════════════════════════
 *  Ethereum Diamond — the iconic octahedron shape
 * ═══════════════════════════════════════════════════════════════════════════ */
function EthDiamond({
  position,
  scale = 1,
  color = '#627EEA',
  speed = 1,
}: {
  position: [number, number, number];
  scale?: number;
  color?: string;
  speed?: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!meshRef.current) return;
    meshRef.current.rotation.y += 0.005 * speed;
    meshRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.3 * speed) * 0.15;
  });

  return (
    <Float speed={1.5 * speed} rotationIntensity={0.4} floatIntensity={1.2} floatingRange={[-0.3, 0.3]}>
      <mesh ref={meshRef} position={position} scale={scale}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.3}
          transparent
          opacity={0.7}
          roughness={0.2}
          metalness={0.8}
        />
      </mesh>
    </Float>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Crypto Coin — flat cylinder with glow
 * ═══════════════════════════════════════════════════════════════════════════ */
function CryptoCoin({
  position,
  scale = 1,
  color = '#E8913A',
  speed = 1,
}: {
  position: [number, number, number];
  scale?: number;
  color?: string;
  speed?: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!meshRef.current) return;
    meshRef.current.rotation.y += 0.008 * speed;
    meshRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.5 * speed) * 0.1;
  });

  return (
    <Float speed={1.2 * speed} rotationIntensity={0.3} floatIntensity={0.8} floatingRange={[-0.2, 0.2]}>
      <mesh ref={meshRef} position={position} scale={scale}>
        <cylinderGeometry args={[1, 1, 0.15, 32]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.25}
          transparent
          opacity={0.6}
          roughness={0.3}
          metalness={0.7}
        />
      </mesh>
    </Float>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Glowing Orb — soft sphere with distortion
 * ═══════════════════════════════════════════════════════════════════════════ */
function GlowOrb({
  position,
  scale = 1,
  color = '#E8913A',
}: {
  position: [number, number, number];
  scale?: number;
  color?: string;
}) {
  return (
    <Float speed={2} rotationIntensity={0.2} floatIntensity={1.5} floatingRange={[-0.4, 0.4]}>
      <mesh position={position} scale={scale}>
        <sphereGeometry args={[1, 32, 32]} />
        <MeshDistortMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.15}
          transparent
          opacity={0.25}
          roughness={1}
          metalness={0}
          distort={0.3}
          speed={2}
        />
      </mesh>
    </Float>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Particle Field — floating sparkles
 * ═══════════════════════════════════════════════════════════════════════════ */
function ParticleField({ count = 80 }: { count?: number }) {
  const pointsRef = useRef<THREE.Points>(null);

  const { positions, sizes } = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const sz = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 20;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 12;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 10 - 2;
      sz[i] = Math.random() * 0.03 + 0.01;
    }
    return { positions: pos, sizes: sz };
  }, [count]);

  useFrame((state) => {
    if (!pointsRef.current) return;
    pointsRef.current.rotation.y = state.clock.elapsedTime * 0.02;
    pointsRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.05) * 0.05;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
        <bufferAttribute
          attach="attributes-size"
          args={[sizes, 1]}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.05}
        color="#E8913A"
        transparent
        opacity={0.4}
        sizeAttenuation
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Grid Floor — subtle grid effect
 * ═══════════════════════════════════════════════════════════════════════════ */
function GridFloor() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -3.5, -2]}>
      <planeGeometry args={[30, 30, 30, 30]} />
      <meshStandardMaterial
        color="#1a1b21"
        wireframe
        transparent
        opacity={0.08}
      />
    </mesh>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Scene — all 3D objects composed together
 * ═══════════════════════════════════════════════════════════════════════════ */
function Scene() {
  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.3} />
      <pointLight position={[5, 5, 5]} intensity={0.8} color="#E8913A" />
      <pointLight position={[-5, 3, -5]} intensity={0.4} color="#627EEA" />
      <pointLight position={[0, -2, 3]} intensity={0.3} color="#E8913A" />

      {/* Large central Ethereum diamond */}
      <EthDiamond position={[0, 0.5, -1]} scale={1.8} color="#627EEA" speed={0.6} />

      {/* Surrounding smaller diamonds */}
      <EthDiamond position={[-3.5, 1.2, -2]} scale={0.7} color="#627EEA" speed={0.8} />
      <EthDiamond position={[3.8, -0.5, -3]} scale={0.5} color="#8C9EFF" speed={1.2} />
      <EthDiamond position={[2.5, 2.0, -2.5]} scale={0.4} color="#627EEA" speed={0.9} />

      {/* Crypto coins */}
      <CryptoCoin position={[-2.5, -1.0, -1.5]} scale={0.6} color="#F7931A" speed={0.7} />  {/* BTC orange */}
      <CryptoCoin position={[4.0, 1.5, -2]} scale={0.5} color="#26A17B" speed={1.0} />     {/* USDT green */}
      <CryptoCoin position={[-4.5, 0.5, -3]} scale={0.45} color="#2775CA" speed={0.8} />    {/* USDC blue */}
      <CryptoCoin position={[1.5, -1.8, -2]} scale={0.5} color="#E8913A" speed={0.9} />     {/* Ember amber */}

      {/* Glow orbs — subtle atmospheric spheres */}
      <GlowOrb position={[-1.5, 2.5, -4]} scale={2.0} color="#E8913A" />
      <GlowOrb position={[3.0, -1.0, -5]} scale={1.5} color="#627EEA" />
      <GlowOrb position={[0, -2.5, -3]} scale={2.5} color="#E8913A" />

      {/* Particle sparkles */}
      <ParticleField count={100} />

      {/* Grid floor */}
      <GridFloor />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Main Export — Canvas wrapper with fade gradient at bottom
 * ═══════════════════════════════════════════════════════════════════════════ */
export default function CryptoBackground() {
  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 0 }}>
      <Canvas
        camera={{ position: [0, 0, 6], fov: 55 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </Canvas>
      {/* Bottom fade into page bg */}
      <div
        className="absolute bottom-0 left-0 right-0 h-32 pointer-events-none"
        style={{
          background: 'linear-gradient(to bottom, transparent, #0c0d10)',
        }}
      />
      {/* Top subtle vignette */}
      <div
        className="absolute top-0 left-0 right-0 h-20 pointer-events-none"
        style={{
          background: 'linear-gradient(to top, transparent, rgba(12,13,16,0.5))',
        }}
      />
    </div>
  );
}
