export default function Hero() {
    return (
        <section className="relative isolate overflow-hidden pt-28 pb-24">
            {/* Glow background */}
            <div
                className="absolute inset-0 -z-10 opacity-60"
                style={{
                    background:
                        "radial-gradient(60% 35% at 50% -10%, rgba(136,74,180,0.35), transparent 60%), radial-gradient(40% 30% at 10% 10%, rgba(184,127,217,0.25), transparent 50%)",
                }}
            />

            <div className="max-w-6xl mx-auto px-6 text-center">
                <span className="inline-block rounded-full border border-white/10 px-3 py-1 text-xs tracking-widest text-[#d4a5e9] uppercase">
                    Synapse — RAG Search & Analytics
                </span>

                <h1 className="mt-6 text-5xl font-bold tracking-tight text-white md:text-6xl">
                    Built for teams with
                    <span className="text-[#b87fd9]"> too much data</span>
                </h1>

                <p className="mt-6 text-lg text-gray-400 max-w-3xl mx-auto">
                    Synapse transforms your documents, databases, and social feeds into a
                    unified search & analytics engine — powered by multi-agent RAG,
                    curiosity-driven reasoning, and serious GPU-grade horsepower.
                </p>

                <div className="mt-10 flex justify-center gap-4">
                    <button className="rounded-xl border border-white/20 bg-[#884ab4] hover:bg-[#9d5fc9] hover:scale-105 hover:shadow-[#884ab4]/40 px-6 py-3 font-medium shadow-xl shadow-[#884ab4]/30 transition-all duration-200 cursor-pointer">
                        Get Started
                    </button>

                    <button className="rounded-xl border border-white/20 hover:bg-white/10 hover:border-white/30 hover:scale-105 px-6 py-3 font-medium transition-all duration-200 cursor-pointer">
                        View Demo
                    </button>
                </div>
            </div>
        </section>
    );
}
