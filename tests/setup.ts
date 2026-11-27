import { vi } from "vitest";
import React from "react";
import "@testing-library/jest-dom/vitest";

// Avoid router context requirements in component tests by rendering Link as a plain anchor.
vi.mock("next/link", () => ({
  default: (props: Record<string, unknown>) =>
    React.createElement(
      "a",
      { href: props.href, ...props },
      props.children as React.ReactNode,
    ),
}));
