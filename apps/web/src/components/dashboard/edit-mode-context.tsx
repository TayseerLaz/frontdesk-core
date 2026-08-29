'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import type { DashboardLayoutApi } from './use-dashboard-layout';

// Edit-mode is plumbed via context so every widget — wherever it sits
// in the tree — can render its ADD/KEEP badge without prop-drilling.
// The layout API rides along on the same context so a widget's
// "remove" button works without each widget re-binding the hook.

interface EditModeContextValue {
  editing: boolean;
  setEditing: (v: boolean) => void;
  layout: DashboardLayoutApi;
}

const EditModeContext = createContext<EditModeContextValue | null>(null);

// Inert context for widgets reused OUTSIDE a dashboard board (e.g. the Usage &
// limits widget on the Analytics page). They render normally, just without the
// edit/KEEP affordances — never editing, layout mutations are no-ops.
const INERT_EDIT_MODE: EditModeContextValue = {
  editing: false,
  setEditing: () => {},
  layout: {
    visible: [],
    hidden: [],
    has: () => false,
    add: () => {},
    remove: () => {},
    reset: () => {},
    onboardingDismissed: true,
    dismissOnboarding: () => {},
  },
};

export function EditModeProvider({
  layout,
  children,
}: {
  layout: DashboardLayoutApi;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const value = useMemo(() => ({ editing, setEditing, layout }), [editing, layout]);
  return <EditModeContext.Provider value={value}>{children}</EditModeContext.Provider>;
}

export function useEditMode(): EditModeContextValue {
  // No provider = widget reused outside a dashboard board. Return an inert,
  // non-editing context so it still renders (rather than crashing the page).
  return useContext(EditModeContext) ?? INERT_EDIT_MODE;
}
