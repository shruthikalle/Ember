'use client';

/**
 * 3D crypto centerpiece — a glowing ETH diamond (octahedron) at the center
 * with orbital BTC / USDC / SOL coins circling around it. Designed to sit
 * BEHIND the hero content as a visual centerpiece, similar to how the
 * inspiration mock has a 3D data center as its centerpiece illustration.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

interface CryptoSceneProps {
  className?: string;
}

export function CryptoScene({ className = '' }: CryptoSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    animationId: number;
    cleanup: () => void;
  } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    // ── Scene setup ────────────────────────────────────────────
    const scene = new THREE.Scene();
    const w = container.clientWidth;
    const h = container.clientHeight;
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1000);
    camera.position.set(0, 0.3, 8);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    // ── Lighting ──────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    const pinkLight = new THREE.PointLight(0xec4899, 5, 20, 1.5);
    pinkLight.position.set(-3, 2, 4);
    scene.add(pinkLight);

    const purpleLight = new THREE.PointLight(0xa855f7, 5, 20, 1.5);
    purpleLight.position.set(3, -2, 4);
    scene.add(purpleLight);

    const amberLight = new THREE.PointLight(0xff7a3d, 4, 20, 1.5);
    amberLight.position.set(0, 4, 3);
    scene.add(amberLight);

    // ── Central ETH diamond ───────────────────────────────────
    // Stretched octahedron = the iconic Ethereum logo
    const ethGeometry = new THREE.OctahedronGeometry(1.0, 0);
    ethGeometry.scale(0.85, 1.2, 0.85);

    const ethMaterial = new THREE.MeshStandardMaterial({
      color: 0xb47cff,
      metalness: 0.85,
      roughness: 0.18,
      emissive: 0x6a3da0,
      emissiveIntensity: 0.35,
    });
    const ethDiamond = new THREE.Mesh(ethGeometry, ethMaterial);
    scene.add(ethDiamond);

    // Wireframe overlay for that "data network" look
    const ethWireGeometry = new THREE.OctahedronGeometry(1.02, 0);
    ethWireGeometry.scale(0.85, 1.2, 0.85);
    const ethWire = new THREE.LineSegments(
      new THREE.EdgesGeometry(ethWireGeometry),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }),
    );
    scene.add(ethWire);

    // Soft glow halo around the diamond (a sprite)
    const haloCanvas = document.createElement('canvas');
    haloCanvas.width = 256;
    haloCanvas.height = 256;
    const hctx = haloCanvas.getContext('2d')!;
    const grad = hctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(168, 85, 247, 0.6)');
    grad.addColorStop(0.4, 'rgba(236, 72, 153, 0.25)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    hctx.fillStyle = grad;
    hctx.fillRect(0, 0, 256, 256);
    const haloTexture = new THREE.CanvasTexture(haloCanvas);
    const haloMaterial = new THREE.SpriteMaterial({ map: haloTexture, transparent: true, depthWrite: false });
    const halo = new THREE.Sprite(haloMaterial);
    halo.scale.set(4, 4, 1);
    scene.add(halo);

    // ── Orbital coins (BTC, USDC, SOL) ────────────────────────
    interface Coin {
      mesh: THREE.Group;
      orbitRadius: number;
      orbitSpeed: number;
      orbitOffset: number;
      tiltY: number;
    }

    const coins: Coin[] = [];

    function makeCoin(color: number, label: string, accent: number): THREE.Group {
      const group = new THREE.Group();
      const geo = new THREE.CylinderGeometry(0.28, 0.28, 0.07, 48);
      geo.rotateX(Math.PI / 2);
      const mat = new THREE.MeshStandardMaterial({
        color, metalness: 0.9, roughness: 0.2, emissive: accent, emissiveIntensity: 0.3,
      });
      const coinMesh = new THREE.Mesh(geo, mat);
      group.add(coinMesh);

      // Edge ring
      const ringGeo = new THREE.TorusGeometry(0.28, 0.008, 8, 64);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      group.add(ring);

      // Symbol on coin face — drawn to a canvas texture
      const txtCanvas = document.createElement('canvas');
      txtCanvas.width = 128;
      txtCanvas.height = 128;
      const tctx = txtCanvas.getContext('2d')!;
      tctx.fillStyle = 'rgba(0,0,0,0)';
      tctx.fillRect(0, 0, 128, 128);
      tctx.fillStyle = '#ffffff';
      tctx.font = 'bold 72px Inter, sans-serif';
      tctx.textAlign = 'center';
      tctx.textBaseline = 'middle';
      tctx.fillText(label, 64, 68);
      const tx = new THREE.CanvasTexture(txtCanvas);
      const faceGeo = new THREE.PlaneGeometry(0.38, 0.38);
      const faceMat = new THREE.MeshBasicMaterial({ map: tx, transparent: true });
      const face = new THREE.Mesh(faceGeo, faceMat);
      face.position.z = 0.037;
      group.add(face);
      const faceBack = face.clone();
      faceBack.position.z = -0.037;
      faceBack.rotation.y = Math.PI;
      group.add(faceBack);

      return group;
    }

    const tokens = [
      { color: 0xf59e0b, label: 'B', accent: 0xff8800, radius: 1.9, speed: 0.30, offset: 0,         tilt: 0.18 }, // BTC
      { color: 0x2775ca, label: '$', accent: 0x4488dd, radius: 2.2, speed: 0.22, offset: Math.PI*0.7, tilt: -0.12 }, // USDC
      { color: 0x14f195, label: 'S', accent: 0x9945ff, radius: 2.5, speed: 0.26, offset: Math.PI*1.3, tilt: 0.05  }, // SOL
    ];

    for (const t of tokens) {
      const coin = makeCoin(t.color, t.label, t.accent);
      scene.add(coin);
      coins.push({
        mesh: coin,
        orbitRadius: t.radius,
        orbitSpeed: t.speed,
        orbitOffset: t.offset,
        tiltY: t.tilt,
      });
    }

    // ── Background dust particles (cheap depth) ───────────────
    const dustCount = 250;
    const dustGeo = new THREE.BufferGeometry();
    const dustPos = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i++) {
      dustPos[i * 3 + 0] = (Math.random() - 0.5) * 18;
      dustPos[i * 3 + 1] = (Math.random() - 0.5) * 12;
      dustPos[i * 3 + 2] = (Math.random() - 0.5) * 12 - 4;
    }
    dustGeo.setAttribute('position', new THREE.Float32BufferAttribute(dustPos, 3));
    const dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.025, transparent: true, opacity: 0.4 }),
    );
    scene.add(dust);

    // ── Animation loop ────────────────────────────────────────
    let t = 0;
    let animationId = 0;

    const animate = () => {
      animationId = requestAnimationFrame(animate);
      t += 0.005;

      // ETH diamond — slow rotation + subtle bob
      ethDiamond.rotation.y = t * 1.4;
      ethDiamond.rotation.x = Math.sin(t * 0.6) * 0.1;
      ethDiamond.position.y = Math.sin(t * 0.8) * 0.12;
      ethWire.rotation.copy(ethDiamond.rotation);
      ethWire.position.copy(ethDiamond.position);
      halo.position.copy(ethDiamond.position);

      // Orbit coins
      for (const c of coins) {
        const angle = t * c.orbitSpeed + c.orbitOffset;
        c.mesh.position.x = Math.cos(angle) * c.orbitRadius;
        c.mesh.position.y = Math.sin(angle * 0.6) * 0.6 + c.tiltY * 2;
        c.mesh.position.z = Math.sin(angle) * c.orbitRadius * 0.6;
        c.mesh.rotation.y = t * 2.5;
      }

      // Camera subtle drift
      camera.position.x = Math.sin(t * 0.3) * 0.3;
      camera.position.y = 0.3 + Math.cos(t * 0.4) * 0.2;
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    };
    animate();

    // ── Resize handling ───────────────────────────────────────
    const handleResize = () => {
      const newW = container.clientWidth;
      const newH = container.clientHeight;
      camera.aspect = newW / newH;
      camera.updateProjectionMatrix();
      renderer.setSize(newW, newH);
    };
    window.addEventListener('resize', handleResize);

    const cleanup = () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationId);
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments || obj instanceof THREE.Points) {
          obj.geometry?.dispose?.();
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material?.dispose?.();
        }
        if (obj instanceof THREE.Sprite) {
          obj.material.dispose();
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }
    };

    sceneRef.current = { renderer, animationId, cleanup };
    return cleanup;
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full pointer-events-none ${className}`}
    />
  );
}

export default CryptoScene;
