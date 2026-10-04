import { useRef, type MouseEvent } from "react";
import { motion } from "framer-motion";
import { text } from "../i18n/dictionary";
import { ACCENTS, THEME_ORDER, useTheme } from "../theme";
import { EASE, riseChild, staggerParent } from "../motion";
import { DOWNLOAD_EXE } from "../constants";
import { CoffeeTip } from "./CoffeeTip";
import { useCampaignStoreLink } from "../campaign-store";

/* ---------- theme selector: one geometric dot per palette ---------- */
function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono-t text-[10px] tracking-[0.2em] text-[var(--fg-dim)]">
        {text.hero.themeLabel}
      </span>
      <div className="flex flex-wrap items-center gap-2.5">
        {THEME_ORDER.map((t) => (
          <button
            key={t}
            aria-label={ACCENTS[t].label}
            title={ACCENTS[t].label}
            onClick={() => setTheme(t)}
            className="h-3.5 w-3.5 rounded-full border transition-all duration-300"
            style={{
              backgroundColor: ACCENTS[t].hex,
              borderColor: theme === t ? "var(--fg)" : "transparent",
              transform: theme === t ? "scale(1.35)" : "scale(1)",
              boxShadow: theme === t ? `0 0 14px ${ACCENTS[t].glow}` : "none",
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function HeroSection() {
  const storeLink = useCampaignStoreLink("pct-website");
  const btnRef = useRef<HTMLAnchorElement>(null);

  /* magnetic CTA — follows the cursor inside its hit-area */
  const onMove = (e: MouseEvent<HTMLAnchorElement>) => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left - r.width / 2) * 0.35;
    const y = (e.clientY - r.top - r.height / 2) * 0.35;
    el.style.transform = `translate(${x}px, ${y}px)`;
  };
  const onLeave = () => {
    const el = btnRef.current;
    if (el) el.style.transform = "translate(0,0)";
  };

  return (
    <header className="overflow-hidden px-5 pt-36 pb-24 md:px-12">
      <motion.div
        className="mx-auto max-w-7xl"
        variants={staggerParent}
        initial="hidden"
        animate="show"
      >
        <motion.div
          variants={riseChild}
          className="mb-8 flex flex-wrap items-center justify-between gap-4"
        >
          <div className="font-mono-t text-accent flex items-center gap-3 text-[12px] tracking-[0.18em]">
            <span className="bg-accent inline-block h-px w-9" />
            {text.hero.eyebrow}
          </div>
          <ThemeSelector />
        </motion.div>

        <motion.h1
          variants={riseChild}
          className="font-display text-[clamp(3rem,8.5vw,7rem)] leading-[0.98] font-bold tracking-[-0.03em] text-[var(--fg)]"
        >
          {text.hero.title1}
          <br />
          {text.hero.title2}
          <br />
          <span className="text-accent">{text.hero.title3}</span>
        </motion.h1>

        {/* asymmetric lower row: deliberate void left, payload right */}
        <div className="mt-14 grid gap-12 md:grid-cols-12">
          <div className="hidden md:col-span-5 md:block" aria-hidden />
          <motion.div variants={riseChild} className="md:col-span-7 lg:col-span-6">
            <p className="max-w-md text-[16.5px] leading-relaxed text-[var(--fg-dim)]">
              <strong className="font-semibold text-[var(--fg)]">{text.hero.subBold}</strong>
              {text.hero.sub}
            </p>

            {/* CoffeeTip owns this row so the tip pill can sit beside the
                download button while its stepper unfolds under both. */}
            <div className="mt-9">
              <CoffeeTip>
                <motion.a
                  ref={btnRef}
                  href={DOWNLOAD_EXE}
                  onMouseMove={onMove}
                  onMouseLeave={onLeave}
                  whileTap={{ scale: 0.97 }}
                  transition={{ duration: 0.6, ease: EASE }}
                  className="bg-accent glow-accent inline-flex items-center gap-2.5 rounded-xl px-8 py-4 text-[15px] font-bold text-[var(--bg)] transition-transform duration-300 will-change-transform"
                >
                  {text.hero.cta}
                  <span className="font-mono-t text-[12px]">↓</span>
                </motion.a>
              </CoffeeTip>
            </div>

            {/* Honest friction disclosure, not hidden in an FAQ: the
                installer isn't code-signed yet, so SmartScreen can interrupt
                the very first click someone makes on this page. Saying so
                up front, right where the click happens, costs us nothing and
                is worth more than a surprise warning would. */}
            <p className="mt-3 max-w-md text-[12.5px] leading-relaxed text-[var(--fg-dim)]">
              {text.hero.safetyNote}
            </p>

            <div className="mt-9 flex flex-wrap gap-5">
              {text.hero.badges.map((b) => (
                <a
                  key={b.label}
                  href={b.href.startsWith("https://apps.microsoft.com/detail/9nh3c6dt1g87") ? storeLink : b.href}
                  target="_blank"
                  rel="noopener"
                  className="font-mono-t flex items-center gap-2 text-[12.5px] text-[var(--fg-dim)] transition-colors hover:text-[var(--fg)]"
                >
                  <span className="bg-accent h-1.5 w-1.5 rounded-full" />
                  {b.label}
                </a>
              ))}
            </div>
          </motion.div>
        </div>
      </motion.div>
    </header>
  );
}
