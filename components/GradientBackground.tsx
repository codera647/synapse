"use client";

/**
 * GradientBackground — animated vivid gradient-mesh blobs behind the page.
 * Pure CSS (no Three.js / no deps). Sits fixed at -z-10; respects reduced motion.
 */
export default function GradientBackground() {
    return (
        <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
            {/* drifting blobs */}
            <div
                className="absolute -top-32 -left-24 h-[42rem] w-[42rem] rounded-full blur-[120px] opacity-50"
                style={{
                    background: "radial-gradient(circle, rgba(139,92,246,0.55), transparent 65%)",
                    animation: "drift 22s ease-in-out infinite",
                }}
            />
            <div
                className="absolute top-10 right-[-10rem] h-[38rem] w-[38rem] rounded-full blur-[120px] opacity-45"
                style={{
                    background: "radial-gradient(circle, rgba(217,70,239,0.45), transparent 65%)",
                    animation: "drift 26s ease-in-out infinite reverse",
                }}
            />
            <div
                className="absolute bottom-[-12rem] left-1/3 h-[40rem] w-[40rem] rounded-full blur-[130px] opacity-40"
                style={{
                    background: "radial-gradient(circle, rgba(59,130,246,0.45), transparent 65%)",
                    animation: "drift 30s ease-in-out infinite",
                }}
            />

            {/* fine grid + grain for depth */}
            <div
                className="absolute inset-0 opacity-[0.18]"
                style={{
                    backgroundImage:
                        "linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)",
                    backgroundSize: "56px 56px",
                    maskImage: "radial-gradient(ellipse 80% 60% at 50% 0%, #000 40%, transparent 80%)",
                    WebkitMaskImage: "radial-gradient(ellipse 80% 60% at 50% 0%, #000 40%, transparent 80%)",
                }}
            />
            {/* top vignette */}
            <div
                className="absolute inset-0"
                style={{ background: "radial-gradient(120% 80% at 50% -10%, transparent 40%, rgba(7,6,15,0.6) 100%)" }}
            />
        </div>
    );
}
