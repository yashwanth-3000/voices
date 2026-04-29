import type { ReactNode } from "react";

type ButtonProps = {
  children: ReactNode;
  variant?: "primary" | "secondary" | "dark";
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
};

export function Button({
  children,
  variant = "secondary",
  href,
  onClick,
  disabled,
  className,
  ariaLabel,
}: ButtonProps) {
  const variantClass =
    variant === "primary"
      ? "btnPrimary"
      : variant === "dark"
        ? "btnDark"
        : "btnSecondary";
  const cls =
    "btn " +
    variantClass +
    (className ? ` ${className}` : "");

  if (href) {
    // Anchors can’t truly be disabled. We reflect disabled state for accessibility.
    const hrefProps = disabled
      ? { "aria-disabled": true as const, tabIndex: -1 }
      : {};
    return (
      <a className={cls} href={href} aria-label={ariaLabel} {...hrefProps}>
        {children}
      </a>
    );
  }

  return (
    <button
      className={cls}
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

