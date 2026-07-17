// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Sidebar layout atoms in their own dep-free module so both the sidebar component
// and keymodel (Cmd+B toggle) can import them without a circular reference.
import { atomWithStorage } from "jotai/utils";

// Persisted across launches via localStorage (survives full reload).
export const sessionSidebarVisibleAtom = atomWithStorage("newwave:sidebar:visible", true);
export const sessionSidebarWidthAtom = atomWithStorage("newwave:sidebar:width", 240);
export const sessionSidebarCollapsedAtom = atomWithStorage("newwave:sidebar:collapsed", false);
