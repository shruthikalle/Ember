'use client';

import { useRef, useMemo, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float } from '@react-three/drei';
import * as THREE from 'three';

/* ═══════════════════════════════════════════════════════════════════════════
 *  Neural Node — glowing sphere representing an AI/data node
 * ═══════════════════════════════════════════════════════════════════════════ */
function NeuralNode({
  position,
  scale = 1,
  color = '#8B5CF6',
  pulseSpeed = 1,
}: {
  position: [number, number, number];
  scale?: number;
  color?: string;
  pulseSpeed?: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!meshRef.current) return;
    const pulse = Math.sin(state.clock.elapsedTime * pulseSpeed) * 0.15 + 1;
    meshRef.current.scale.setScalar(scale * pulse);
    if (glowRef.current) {
      glowRef.current.scale.setScalar(scale * pulse * 2.5);
    }
  });

  return (
    <group position={position}>
      {/* Outer glow */}
      <mesh ref={glowRef}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.06}
          depthWrite={false}
        />
      </mesh>
      {/* Core node */}
      <Float speed={1.5 * pulseSpeed} rotationIntensity={0.1} floatIntensity={0.5} floatingRange={[-0.1, 0.1]}>
        <mesh ref={meshRef}>
          <sphereGeometry args={[1, 24, 24]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.5}
            transparent
            opacity={0.85}
            roughness={0.3}
            metalness={0.6}
          />
        </mesh>
      </Float>
    </group>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Data Stream — animated line connecting two nodes
 * ═══════════════════════════════════════════════════════════════════════════ */
function DataStream({
  start,
  end,
  color = '#8B5CF6',
  speed = 1,
}: {
  start: [number, number, number];
  end: [number, number, number];
  color?: string;
  speed?: number;
}) {
  const lineRef = useRef<THREE.Line>(null);

  const { geometry, material } = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const segments = 30;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = start[0] + (end[0] - start[0]) * t;
      const y = start[1] + (end[1] - start[1]) * t;
      const z = start[2] + (end[2] - start[2]) * t;
      const curve = Math.sin(t * Math.PI) * 0.3;
      pts.push(new THREE.Vector3(x, y + curve, z));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { geometry: geo, material: mat };
  }, [start, end, color]);

  useFrame((state) => {
    if (!lineRef.current) return;
    const mat = lineRef.current.material as THREE.LineBasicMaterial;
    mat.opacity = 0.15 + Math.sin(state.clock.elapsedTime * speed + start[0]) * 0.1;
  });

  const lineObject = useMemo(() => new THREE.Line(geometry, material), [geometry, material]);

  return <primitive ref={lineRef} object={lineObject} />;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Pulse Particle — tiny sphere traveling along a path
 * ═══════════════════════════════════════════════════════════════════════════ */
function PulseParticle({
  start,
  end,
  color = '#A78BFA',
  speed = 0.4,
  delay = 0,
}: {
  start: [number, number, number];
  end: [number, number, number];
  color?: string;
  speed?: number;
  delay?: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = ((state.clock.elapsedTime * speed + delay) % 1);
    const x = start[0] + (end[0] - start[0]) * t;
    const y = start[1] + (end[1] - start[1]) * t + Math.sin(t * Math.PI) * 0.3;
    const z = start[2] + (end[2] - start[2]) * t;
    meshRef.current.position.set(x, y, z);
    // Fade in/out at ends
    const fade = Math.sin(t * Math.PI);
    const mat = meshRef.current.material as THREE.MeshBasicMaterial;
    mat.opacity = fade * 0.8;
    meshRef.current.scale.setScalar(0.06 + fade * 0.04);
  });

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1, 8, 8]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={0.6}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Ambient Particles — floating dust in the scene
 * ═══════════════════════════════════════════════════════════════════════════ */
function AmbientParticles({ count = 60 }: { count?: number }) {
  const pointsRef = useRef<THREE.Points>(null);

  const positions = useMemo(() => {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 18;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 10;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 8 - 3;
    }
    return pos;
  }, [count]);

  useFrame((state) => {
    if (!pointsRef.current) return;
    pointsRef.current.rotation.y = state.clock.elapsedTime * 0.015;
    pointsRef.current.rotation.z = Math.sin(state.clock.elapsedTime * 0.03) * 0.03;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.04}
        color="#8B5CF6"
        transparent
        opacity={0.35}
        sizeAttenuation
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Hexagonal Ring — subtle wireframe ring
 * ═══════════════════════════════════════════════════════════════════════════ */
function HexRing({
  position,
  scale = 1,
  color = '#4C1D95',
  speed = 0.3,
}: {
  position: [number, number, number];
  scale?: number;
  color?: string;
  speed?: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!meshRef.current) return;
    meshRef.current.rotation.z += 0.003 * speed;
    meshRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.2) * 0.1;
  });

  return (
    <mesh ref={meshRef} position={position} scale={scale}>
      <torusGeometry args={[1, 0.02, 6, 6]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={0.15}
        wireframe
        depthWrite={false}
      />
    </mesh>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Scene — Neural network layout
 * ═══════════════════════════════════════════════════════════════════════════ */

// Node positions for the neural network layout
const NODES: { pos: [number, number, number]; color: string; scale: number; pulse: number }[] = [
  // Central cluster
  { pos: [0, 0.5, -1], color: '#8B5CF6', scale: 0.25, pulse: 0.8 },
  { pos: [-1.5, 1.5, -2], color: '#A78BFA', scale: 0.18, pulse: 1.0 },
  { pos: [1.8, 1.0, -1.5], color: '#7C3AED', scale: 0.2, pulse: 0.9 },
  { pos: [-0.5, -1.2, -1.8], color: '#6D28D9', scale: 0.15, pulse: 1.2 },
  { pos: [2.5, -0.5, -2.5], color: '#A78BFA', scale: 0.12, pulse: 0.7 },
  // Outer ring
  { pos: [-3.5, 0.8, -3], color: '#E8913A', scale: 0.14, pulse: 0.6 },
  { pos: [3.8, 1.8, -2.8], color: '#E8913A', scale: 0.16, pulse: 0.8 },
  { pos: [-2.5, -1.5, -2.5], color: '#7C3AED', scale: 0.13, pulse: 1.1 },
  { pos: [0.5, 2.5, -3], color: '#8B5CF6', scale: 0.11, pulse: 0.9 },
  { pos: [-1.0, -2.5, -2], color: '#A78BFA', scale: 0.1, pulse: 1.0 },
  // Far nodes
  { pos: [4.5, -1.5, -4], color: '#6D28D9', scale: 0.1, pulse: 0.5 },
  { pos: [-4.0, 2.0, -4], color: '#8B5CF6', scale: 0.12, pulse: 0.7 },
  { pos: [1.0, -2.8, -3.5], color: '#7C3AED', scale: 0.09, pulse: 0.8 },
];

// Connections between nodes
const CONNECTIONS: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [0, 4],
  [1, 5], [1, 8], [2, 6], [2, 4],
  [3, 7], [3, 9], [4, 10],
  [5, 11], [6, 10], [7, 12], [8, 11],
  [1, 2], [3, 4], [5, 7],
];

function Scene() {
  return (
    <>
      {/* Lighting — purple/violet tones */}
      <ambientLight intensity={0.2} />
      <pointLight position={[3, 3, 4]} intensity={0.6} color="#8B5CF6" />
      <pointLight position={[-3, 2, -3]} intensity={0.4} color="#E8913A" />
      <pointLight position={[0, -3, 2]} intensity={0.3} color="#A78BFA" />

      {/* Neural nodes */}
      {NODES.map((node, i) => (
        <NeuralNode
          key={`node-${i}`}
          position={node.pos}
          scale={node.scale}
          color={node.color}
          pulseSpeed={node.pulse}
        />
      ))}

      {/* Data streams connecting nodes */}
      {CONNECTIONS.map(([a, b], i) => (
        <DataStream
          key={`stream-${i}`}
          start={NODES[a].pos}
          end={NODES[b].pos}
          color={i % 3 === 0 ? '#E8913A' : '#8B5CF6'}
          speed={0.5 + (i % 4) * 0.3}
        />
      ))}

      {/* Traveling pulse particles along some connections */}
      {CONNECTIONS.slice(0, 10).map(([a, b], i) => (
        <PulseParticle
          key={`pulse-${i}`}
          start={NODES[a].pos}
          end={NODES[b].pos}
          color={i % 2 === 0 ? '#E8913A' : '#C4B5FD'}
          speed={0.25 + (i % 3) * 0.15}
          delay={i * 0.37}
        />
      ))}

      {/* Hexagonal rings — subtle decorative */}
      <HexRing position={[-2, 0, -5]} scale={2.5} color="#4C1D95" speed={0.2} />
      <HexRing position={[3, 1, -4.5]} scale={1.8} color="#4C1D95" speed={0.3} />
      <HexRing position={[0, -1.5, -6]} scale={3.0} color="#3B0764" speed={0.15} />

      {/* Ambient particles */}
      <AmbientParticles count={80} />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Main Export
 * ═══════════════════════════════════════════════════════════════════════════ */
export default function ChatBackground() {
  return (
    <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 0 }}>
      <Canvas
        camera={{ position: [0, 0, 5], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </Canvas>
      {/* Top vignette */}
      <div
        className="absolute top-0 left-0 right-0 h-24 pointer-events-none"
        style={{ background: 'linear-gradient(to top, transparent, rgba(12,13,16,0.6))' }}
      />
      {/* Bottom vignette */}
      <div
        className="absolute bottom-0 left-0 right-0 h-24 pointer-events-none"
        style={{ background: 'linear-gradient(to bottom, transparent, rgba(12,13,16,0.6))' }}
      />
    </div>
  );
}
