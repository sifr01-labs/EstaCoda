export type OverlayDescriptor<TId extends string = string> = {
  readonly id: TId;
  readonly kind: string;
  readonly dismissible?: boolean;
};

export type OverlayStackState<TId extends string = string> = {
  readonly overlays: readonly OverlayDescriptor<TId>[];
};

export type OverlayStackIntent<TId extends string = string, TIntent = unknown> =
  | { readonly type: "pushed"; readonly overlay: OverlayDescriptor<TId> }
  | { readonly type: "popped"; readonly overlay: OverlayDescriptor<TId> }
  | { readonly type: "captured"; readonly overlay: OverlayDescriptor<TId>; readonly intent?: TIntent }
  | { readonly type: "blocked"; readonly reason: "required-overlay" | "empty" };

export type OverlayStackResult<TId extends string = string, TIntent = unknown> = {
  readonly state: OverlayStackState<TId>;
  readonly intent?: OverlayStackIntent<TId, TIntent>;
};

export function createOverlayStack<TId extends string = string>(
  overlays: readonly OverlayDescriptor<TId>[] = []
): OverlayStackState<TId> {
  return {
    overlays: [...overlays],
  };
}

export function pushOverlay<TId extends string = string>(
  state: OverlayStackState<TId>,
  overlay: OverlayDescriptor<TId>
): OverlayStackResult<TId> {
  return {
    state: {
      overlays: [...state.overlays, overlay],
    },
    intent: {
      type: "pushed",
      overlay,
    },
  };
}

export function topOverlay<TId extends string = string>(
  state: OverlayStackState<TId>
): OverlayDescriptor<TId> | undefined {
  return state.overlays[state.overlays.length - 1];
}

export function popOverlay<TId extends string = string>(
  state: OverlayStackState<TId>,
  options: { readonly force?: boolean } = {}
): OverlayStackResult<TId> {
  const overlay = topOverlay(state);
  if (overlay === undefined) {
    return {
      state,
      intent: {
        type: "blocked",
        reason: "empty",
      },
    };
  }
  if (overlay.dismissible === false && options.force !== true) {
    return {
      state,
      intent: {
        type: "blocked",
        reason: "required-overlay",
      },
    };
  }
  return {
    state: {
      overlays: state.overlays.slice(0, -1),
    },
    intent: {
      type: "popped",
      overlay,
    },
  };
}

export function dispatchToTopOverlay<TId extends string = string, TEvent = unknown, TIntent = unknown>(
  state: OverlayStackState<TId>,
  event: TEvent,
  handler: (overlay: OverlayDescriptor<TId>, event: TEvent) => TIntent | undefined
): OverlayStackResult<TId, TIntent> {
  const overlay = topOverlay(state);
  if (overlay === undefined) {
    return {
      state,
      intent: {
        type: "blocked",
        reason: "empty",
      },
    };
  }
  return {
    state,
    intent: {
      type: "captured",
      overlay,
      intent: handler(overlay, event),
    },
  };
}

export function applyOverlayEscape<TId extends string = string>(
  state: OverlayStackState<TId>
): OverlayStackResult<TId> {
  return popOverlay(state);
}
