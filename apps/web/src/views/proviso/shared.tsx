"use client";
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { animated, useSpring } from "@react-spring/web";
import { useMotionOff } from "@/hooks/use-motion-off";

export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 44 48"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M2 3h16v7H9v31h9v7H2z" />
      <circle cx="28" cy="18" r="15" />
    </svg>
  );
}
export type IconName =
  | "arrow"
  | "diagonal"
  | "play"
  | "plus"
  | "close"
  | "check"
  | "seal"
  | "wave"
  | "key"
  | "write"
  | "ledger"
  | "github"
  | "telegram"
  | "x"
  | "download"
  | "menu"
  | "chevron"
  | "copy"
  | "trash"
  | "clock"
  | "shield"
  | "link";
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <path d="M4 12h15M13 5l7 7-7 7" />,
    diagonal: <path d="M5 19 19 5M5 5h14v14" />,
    play: <path d="m8 5 11 7-11 7z" />,
    plus: <path d="M12 4v16M4 12h16" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    check: <path d="m4 12 5 5L20 6" />,
    seal: (
      <>
        <path d="M4 4h10M4 4v16h10M9 8v8" />
        <circle cx="16" cy="9" r="5" />
      </>
    ),
    wave: (
      <>
        <path d="M3 7h13l4 4M3 17h13l4-4" />
        <circle cx="5" cy="7" r="1.5" />
        <circle cx="9" cy="7" r="1.5" />
        <circle cx="5" cy="17" r="1.5" />
      </>
    ),
    key: (
      <>
        <circle cx="8" cy="8" r="5" />
        <path d="m12 12 9 9M16 16l3-3M19 19l3-3" />
      </>
    ),
    write: (
      <>
        <path d="M4 19v-4L16 3l5 5L9 20H4zM13 6l5 5M4 23h16" />
      </>
    ),
    ledger: (
      <>
        <path d="M5 3h14v18H5zM8 7h8M8 12h8M8 17h4" />
        <path d="M2 6h5M2 11h5M2 16h5" />
      </>
    ),
    github: (
      <path
        fill="currentColor"
        stroke="none"
        d="M12 .8a11.4 11.4 0 0 0-3.6 22.2c.6.1.8-.2.8-.5v-2c-3.3.7-4-1.4-4-1.4-.5-1.3-1.3-1.6-1.3-1.6-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11.4 11.4 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.5-2.8 5.5-5.5 5.8.4.4.8 1.1.8 2.2v3c0 .3.2.6.8.5A11.4 11.4 0 0 0 12 .8Z"
      />
    ),
    telegram: (
      <>
        <path d="m3 10 18-7-4 18-6-6-4 3 1-6z" />
        <path d="m8 12 9-5-6 8" />
      </>
    ),
    x: (
      <>
        <path d="M4 3h4l12 18h-4L4 3Z" />
        <path d="m20 3-7 8M11 14l-7 7" />
      </>
    ),
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    menu: <path d="M4 7h16M4 16h16" />,
    chevron: <path d="m6 9 6 6 6-6" />,
    copy: (
      <>
        <rect x="8" y="8" width="12" height="13" rx="1" />
        <path d="M15 8V3H3v13h5" />
      </>
    ),
    trash: <path d="M4 6h16M9 3h6M6 6l1 15h10l1-15M10 10v7M14 10v7" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 3" />
      </>
    ),
    shield: <path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6zM8 12l3 3 5-6" />,
    link: (
      <>
        <path
          d="m10 14 4-4M8 16l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 0-5-5L8 6a4 4 0 0 0 0 6"
          transform="translate(2 2)"
        />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
type ModalData = {
  title: string;
  body: string;
  eyebrow?: string;
  video?: boolean;
};
const ModalContext = createContext<(data: ModalData) => void>(() => {});
export function useModal() {
  return useContext(ModalContext);
}
export function AppProvider({ children }: { children: ReactNode }) {
  const [modal, setModal] = useState<ModalData | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const before = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!modal) return;
    before.current = document.activeElement as HTMLElement;
    dialog.current?.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = old;
      before.current?.focus();
    };
  }, [modal]);
  const close = () => {
    dialog.current?.close();
    setModal(null);
  };
  return (
    <ModalContext.Provider value={setModal}>
      {children}
      {modal && (
        <dialog
          ref={dialog}
          className={`modal ${modal.video ? "film-modal" : ""}`}
          onCancel={close}
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
          aria-labelledby="modal-title"
        >
          <button
            className="icon-button modal-close"
            aria-label="Close dialog"
            onClick={close}
          >
            <Icon name="close" />
          </button>
          {modal.video ? (
            <>
              <h2 id="modal-title" className="sr-only">
                The Proviso introduction
              </h2>
              <video
                src="/assets/intro.mp4"
                controls
                autoPlay
                playsInline
                preload="metadata"
              />
            </>
          ) : (
            <div className="modal-body">
              <div className="modal-symbol">
                <Mark />
              </div>
              <span className="eyebrow">
                {modal.eyebrow || "PROVISO / NEXT CHAPTER"}
              </span>
              <h2 id="modal-title">{modal.title}</h2>
              <p>{modal.body}</p>
              <button className="button light" onClick={close}>
                Back to Proviso <Icon name="arrow" />
              </button>
            </div>
          )}
        </dialog>
      )}
    </ModalContext.Provider>
  );
}
export function Socials() {
  const open = useModal();
  return (
    <div className="socials">
      {(
        [
          ["x", "X"],
          ["telegram", "Telegram"],
          ["github", "GitHub"],
        ] as [IconName, string][]
      ).map(([icon, label]) => (
        <button
          className="icon-button"
          key={icon}
          aria-label={label}
          onClick={() =>
            open({
              title: "Coming soon.",
              eyebrow: `PROVISO / ${label.toUpperCase()}`,
              body: "Our official channels are being prepared. You’ll find the verified links here when they’re ready.",
            })
          }
        >
          <Icon name={icon} size={18} />
        </button>
      ))}
    </div>
  );
}
export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const off = useMotionOff();
  const [styles, api] = useSpring(() => ({ opacity: 1, y: 0 }));
  useEffect(() => {
    if (off) return;
    const el = ref.current;
    if (!el) return;
    api.set({ opacity: 0, y: 28 });
    const o = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          api.start({
            opacity: 1,
            y: 0,
            delay,
            config: { tension: 110, friction: 26 },
          });
          o.disconnect();
        }
      },
      { threshold: 0.05 },
    );
    o.observe(el);
    return () => o.disconnect();
  }, [off, api, delay]);
  return (
    <animated.div
      ref={ref}
      className={className}
      style={{
        opacity: styles.opacity,
        transform: styles.y.to((y) => `translate3d(0,${y}px,0)`),
      }}
    >
      {children}
    </animated.div>
  );
}
