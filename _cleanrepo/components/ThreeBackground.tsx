"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useRef } from "react";
import * as THREE from "three";

function WavyMesh() {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const mesh = meshRef.current;
    if (!mesh) return;
    const position = mesh.geometry.attributes.position;
    const count = position.count;

    for (let i = 0; i < count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const wave =
        Math.sin(x * 0.5 + t * 0.8) * 0.12 +
        Math.cos(y * 0.8 + t * 0.6) * 0.08;
      position.setZ(i, wave);
    }

    position.needsUpdate = true;
  });

  return (
    <mesh ref={meshRef} rotation={[-Math.PI / 2.4, 0, 0]}>
      <planeGeometry args={[12, 12, 60, 60]} />
      <meshStandardMaterial
        color={"#6D28D9"}
        emissive={"#4C1D95"}
        roughness={0.35}
        metalness={0.25}
        wireframe
      />
    </mesh>
  );
}

export default function ThreeBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10">
      <Canvas camera={{ position: [0, 3.5, 6], fov: 55 }}>
        <ambientLight intensity={0.4} />
        <pointLight position={[4, 6, 4]} intensity={1.2} />
        <WavyMesh />
        <OrbitControls
          enablePan={false}
          enableZoom={false}
          enableRotate={false}
        />
      </Canvas>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background/10 via-background/70 to-background" />
    </div>
  );
}
