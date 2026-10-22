"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSpring } from "@react-spring/web";
import { ScrollLayout } from "@/layouts/scroll-layout";
import { StackBlock } from "@/views/home/stack-block";
import { FooterReveal } from "@/views/home/footer-reveal";
import { RippleLayer } from "@/views/home/ripple-layer";
import { BottleMist } from "@/views/home/sections/bottle-mist";
import { useProgressTrigger } from "@/hooks/animation/use-progress-trigger";
import { useMotionOff } from "@/hooks/use-motion-off";
import { Icon, Reveal, useModal } from "./shared";
import { Glyph } from "./glyph";
import { SiteNav, SiteFooter, productLinks } from "@/views/product/site-shell";

// Contract address, set on Vercel as NEXT_PUBLIC_CA (build-time: redeploy after changing it).
const CA = process.env.NEXT_PUBLIC_CA?.trim() || "TBA";
function CaCopy() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="h-ca eyebrow"
      aria-label={`Copy contract address ${CA}`}
      onClick={() =>
        navigator.clipboard?.writeText(CA).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      CA : <span>{CA}</span>
      <em aria-live="polite">{copied ? "COPIED" : <Icon name="copy" size={12} />}</em>
    </button>
  );
}

const phases = [
  [
    "Write",
    "Give the idea a structure.",
    "Describe what needs to happen, what to do, and where to exit. Review every readable rule before you confirm.",
  ],
  [
    "Seal",
    "Put the commitment first.",
    "Separate entry and exit commitments establish the idea before the outcome. Public disclosure follows a defined timeline.",
  ],
  [
    "Record",
    "Keep the whole sequence.",
    "A fired idea, an expired call, a retired thesis. Each belongs in a record that goes beyond the winning screenshot.",
  ],
];
function ThesisSection() {
  const [phase, setPhase] = useState(0);
  const ref = useRef<HTMLElement>(null);
  const off = useMotionOff();
  const [motion, api] = useSpring(() => ({ p: 1 }));
  useProgressTrigger({
    elementRef: ref,
    start: "top bottom",
    end: "center center",
    frameInterval: 0,
    onChange: ({ progress }) => {
      api.start({
        p: off ? 1 : Math.min(1, Math.max(0, progress)),
        config: { tension: 90, friction: 26 },
      });
    },
  });
  return (
    <section ref={ref} className="h-thesis">
      <div className="h-section-label">
        <span className="eyebrow">01 / FROM THOUGHT TO THESIS</span>
        <span className="eyebrow">INTENT, MADE EXPLICIT.</span>
      </div>
      <div className="h-thesis-grid">
        <div>
          <Reveal>
            <h2>
              Conviction.
              <br />
              With conditions.
            </h2>
          </Reveal>
          <p className="h-section-intro">
            A sentence is a beginning.
            <br />A confirmed rule is a commitment.
          </p>
          <div className="h-phase-tabs" aria-label="Thesis lifecycle">
            {phases.map(([label], i) => (
              <button
                key={label}
                aria-pressed={phase === i}
                onClick={() => setPhase(i)}
              >
                <span>0{i + 1}</span>
                {label}
              </button>
            ))}
          </div>
          <div className="h-phase-copy" key={phase}>
            <h3>{phases[phase][1]}</h3>
            <p>{phases[phase][2]}</p>
          </div>
          <Link href="/protocol/" className="text-link">
            Explore the complete protocol <Icon name="diagonal" size={17} />
          </Link>
        </div>
        <div className="h-proof-art">
          <BottleMist
            src="/assets/v2/proof-layers.webp"
            alt="Four suspended optical glass planes representing the layers of a commitment"
            width={1536}
            height={1024}
            className="h-proof-object"
            progress={motion.p}
            startHidden={false}
          />
          <span className="eyebrow h-art-caption">
            FIG. 01 / THE LAYERS OF A CALL
          </span>
          <div className="h-rule-strip">
            <span className="eyebrow">A THESIS, EXPRESSED</span>
            <p>
              When funding turns negative.
              <br />
              And price holds above $40.
            </p>
            <div>
              <code>LONG HYPE · 3×</code>
              <span>STOP −6% / TAKE +15%</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
function SequenceSection() {
  return (
    <section className="h-sequence">
      <div className="h-section-label">
        <span className="eyebrow">02 / FAIR COPY</span>
        <span className="eyebrow">ORDER IS A DESIGN CHOICE.</span>
      </div>
      <div className="h-sequence-heading">
        <Reveal>
          <h2>
            Followers first.
            <br />
            <span>Caller second.</span>
          </h2>
        </Reveal>
        <p>
          One idea. Two waves.
          <br />A shared reference for exits.
        </p>
      </div>
      <div className="h-sequence-grid">
        <div className="h-sequence-art">
          <img
            src="/assets/v2/execution-paths.webp"
            alt="Two precision glass and silver paths, offset to express successive order waves"
            loading="lazy"
          />
          <RippleLayer />
          <span className="eyebrow">FIG. 02 / A DELIBERATE SEQUENCE</span>
        </div>
        <div className="h-sequence-steps">
          {[
            [
              "01",
              "Your own boundaries.",
              "Followers choose their allocation, leverage ceiling, markets, and direction policy.",
            ],
            [
              "02",
              "Followers’ wave.",
              "Eligible follower orders go first, subject to liquidity and price-band limits.",
            ],
            [
              "03",
              "Then the caller.",
              "The linked caller account follows after acknowledgements. Separate orders may receive different fills.",
            ],
          ].map(([n, t, b]) => (
            <Reveal key={n}>
              <span>{n}</span>
              <div>
                <h3>{t}</h3>
                <p>{b}</p>
              </div>
            </Reveal>
          ))}
          <Link href="/fair-copy/" className="text-link">
            Inside Fair Copy <Icon name="diagonal" size={17} />
          </Link>
        </div>
      </div>
    </section>
  );
}
function WorkspaceSection() {
  return (
    <section className="h-workspace">
      <div className="h-section-label">
        <span className="eyebrow">03 / THE THESIS WORKSPACE</span>
        <span className="eyebrow">DESIGNED AROUND THE DECISION.</span>
      </div>
      <div className="h-workspace-grid">
        <div>
          <Reveal>
            <h2>
              Less noise.
              <br />
              More intent.
            </h2>
          </Reveal>
          <p>
            From the first clause to the final record. A workspace that keeps
            the idea, the permissions, and the evidence connected.
          </p>
          <Link href="/dashboard/" className="button">
            Enter the workspace <Icon name="diagonal" size={17} />
          </Link>
          <span className="h-local-label">
            WRITE WITH INTENT / KEEP EVERY CLAUSE
          </span>
        </div>
        <div className="h-workspace-model">
          <div className="h-model-header">
            <Glyph name="overview" size={25} />
            <span>YOUR THESIS DESK</span>
            <i>PERSONAL WORKSPACE</i>
          </div>
          <div className="h-model-body">
            <span className="eyebrow">START WITH WHAT YOU BELIEVE.</span>
            <h3>
              Make room
              <br />
              for conviction.
            </h3>
            <div className="h-mini-rule">
              <span>IF</span>
              <p>the conditions hold</p>
              <Glyph name="signal" size={28} />
            </div>
            <div className="h-mini-rule">
              <span>THEN</span>
              <p>follow the confirmed intent</p>
              <Glyph name="position" size={28} />
            </div>
            <div className="h-mini-rule">
              <span>WITH</span>
              <p>limits you can inspect</p>
              <Glyph name="limits" size={28} />
            </div>
          </div>
          <div className="h-model-tools">
            {[
              ["Compose", "/dashboard/compose/"],
              ["Test", "/dashboard/replay/"],
              ["Record", "/dashboard/records/"],
            ].map(([label, href], i) => (
              <Link href={href} key={label}>
                <span>0{i + 1}</span>
                {label}
                <Icon name="diagonal" size={14} />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
const faq = [
  [
    "What makes a thesis different from a trade?",
    "A thesis states the conditions before the action: what must happen, what to do, and where to exit. Proviso brings those rules, your limits, and the resulting record into one workflow.",
  ],
  [
    "What does a seal prove?",
    "The seal is a commitment to the rules and establishes a commitment and its timing. It does not establish that a strategy is profitable. Entry and exit are committed separately and revealed at different stages.",
  ],
  [
    "Who can read a sealed idea?",
    "The public cannot read a sealed rule before its reveal. The evaluator must decrypt the specification inside an isolated environment to run it. Sealing is not secrecy from the evaluator.",
  ],
  [
    "Does Proviso hold my funds?",
    "The self-custody model keeps the main key with the owner. Trading and swap permissions are limited and revocable; trading access can still incur losses.",
  ],
  [
    "Where can I explore the full protocol?",
    "The guide library covers the thesis lifecycle, Proof of Call, Fair Copy, execution, self-custody, strategy testing, integrations, the record, and architecture.",
  ],
];
export function Landing() {
  const open = useModal();
  const bg = useRef<HTMLDivElement>(null);
  const off = useMotionOff();
  useEffect(() => {
    const el = bg.current;
    if (!el || off) return;
    const scroll = () => {
      const p = Math.min(1, window.scrollY / window.innerHeight);
      el.style.transform = `scale(${1 + p * 0.18})`;
    };
    window.addEventListener("scroll", scroll, { passive: true });
    return () => window.removeEventListener("scroll", scroll);
  }, [off]);
  return (
    <ScrollLayout>
      <div className="home-v2">
        <SiteNav dark />
        <main id="main" className="relative z-10">
          <StackBlock tone="dark" fixed stick={false}>
            <section className="h-hero">
              <div className="h-hero-background" ref={bg}>
                <img
                  src="/assets/v2/hero-field.webp"
                  alt="Abstract silver glass architecture in a dark field of fine matrix points"
                  fetchPriority="high"
                />
                <RippleLayer />
              </div>
              <div className="h-hero-center">
                <Reveal>
                  <CaCopy />
                  <span className="eyebrow">
                    THESIS TRADING / WITH A RECORD
                  </span>
                  <h1>
                    Write the call.
                    <br />
                    Seal it.
                    <br />
                    <span>Get proven right.</span>
                  </h1>
                  <p>Your thesis. Your rules. Your record.</p>
                  <div className="h-hero-actions">
                    <Link href="/dashboard/" className="button light">
                      Explore the workspace <Icon name="diagonal" size={17} />
                    </Link>
                    <button
                      className="h-watch"
                      onClick={() =>
                        open({ title: "Introduction", body: "", video: true })
                      }
                    >
                      <span>
                        <Icon name="play" size={13} />
                      </span>
                      Watch the film
                    </button>
                  </div>
                </Reveal>
              </div>
              <div className="h-hero-bottom">
                <span className="eyebrow">
                  DESIGNED FOR
                  <br />
                  <b>ROBINHOOD CHAIN × HYPERLIQUID</b>
                </span>
                <a href="#protocol" aria-label="Explore the protocol">
                  <span className="eyebrow">THE IDEA, EXPLAINED</span>
                  <Icon name="arrow" size={20} />
                </a>
                <span className="eyebrow">
                  PROVISO / THESIS TRADING
                  <br />
                  <b>A NEW STRUCTURE FOR CONVICTION</b>
                </span>
              </div>
            </section>
          </StackBlock>
          <StackBlock id="protocol" tone="light">
            <ThesisSection />
          </StackBlock>
          <StackBlock tone="dark">
            <SequenceSection />
          </StackBlock>
          <StackBlock tone="light">
            <WorkspaceSection />
          </StackBlock>
          <StackBlock tone="light" stick={false}>
            <section className="h-explore">
              <div className="h-explore-intro">
                <span className="eyebrow">04 / BEYOND THE FIRST CALL</span>
                <h2>
                  Every part.
                  <br />
                  Considered.
                </h2>
                <p>
                  The product is in the details.
                  <br />
                  Explore the system behind the sentence.
                </p>
              </div>
              <div className="h-explore-links">
                {productLinks
                  .filter((_, i) => ![0, 2].includes(i))
                  .map(([href, title, sub, icon], i) => (
                    <Link href={href} key={href}>
                      <Glyph name={icon} size={35} />
                      <div>
                        <span className="eyebrow">0{i + 1} / EXPLORE</span>
                        <h3>{title}</h3>
                        <p>{sub}</p>
                      </div>
                      <Icon name="diagonal" size={20} />
                    </Link>
                  ))}
              </div>
            </section>
          </StackBlock>
          <StackBlock tone="dark">
            <section className="h-film">
              <div className="h-section-label">
                <span className="eyebrow">05 / MEET PROVISO</span>
                <span className="eyebrow">THE INTRODUCTION</span>
              </div>
              <div className="h-film-heading">
                <h2>
                  The whole idea.
                  <br />
                  In 105 seconds.
                </h2>
                <p>
                  A first look at thesis trading,
                  <br />
                  and the commitment behind the call.
                </p>
              </div>
              <button
                className="h-film-poster"
                aria-label="Play the Proviso introduction"
                onClick={() =>
                  open({ title: "Introduction", body: "", video: true })
                }
              >
                <img
                  src="/assets/banner.png"
                  alt="Proviso: Write the call. Seal it. Get proven right."
                  loading="lazy"
                />
                <span>
                  <Icon name="play" size={22} />
                </span>
                <small>PLAY INTRODUCTION</small>
              </button>
            </section>
          </StackBlock>
          <StackBlock tone="light" stick={false}>
            <section className="h-faq">
              <div>
                <span className="eyebrow">A FEW THINGS, CLEARLY.</span>
                <h2>
                  Before your
                  <br />
                  first call.
                </h2>
                <Link href="/docs/" className="text-link">
                  Read the documentation <Icon name="diagonal" size={17} />
                </Link>
              </div>
              <div>
                {faq.map(([q, a], i) => (
                  <details key={q}>
                    <summary>
                      <span>0{i + 1}</span>
                      {q}
                      <Icon name="plus" size={18} />
                    </summary>
                    <p>{a}</p>
                  </details>
                ))}
              </div>
            </section>
          </StackBlock>
        </main>
        <FooterReveal>
          <SiteFooter />
        </FooterReveal>
      </div>
    </ScrollLayout>
  );
}
