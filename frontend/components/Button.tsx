import type { ReactNode } from "react";

type ButtonProps = {
  children: ReactNode;
  variant?: "primary" | "secondary";
  href?: string;
  onClick?: () => void;
  className?: string;
  ariaLabel?: string;
};

export function Button({
  children,
  variant = "secondary",
  href,
  onClick,
  className,
  ariaLabel,
}: ButtonProps) {
  const cls =
    "btn " +
    (variant === "primary" ? "btnPrimary" : "btnSecondary") +
    (className ? ` ${className}` : "");

  if (href) {
    return (
      <a className={cls} href={href} aria-label={ariaLabel}>
        {children}
      </a>
    );
  }

  return (
    <button className={cls} onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  );
}

