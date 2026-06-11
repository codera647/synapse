import Navbar from "@/components/Navbar";
import GradientBackground from "@/components/GradientBackground";
import Hero from "@/components/Hero";
import Features from "@/components/Features";
import HowItWorks from "@/components/HowItWorks";
import TechStack from "@/components/TechStack";
import CTA from "@/components/CTA";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-x-hidden">
      <GradientBackground />
      <Navbar />
      <Hero />
      <Features />
      <HowItWorks />
      <TechStack />
      <CTA />
      <Footer />
    </main>
  );
}
