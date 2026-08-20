export type BrowserBackendKind =
  | "local-cdp"
  | "browserbase"
  | "firecrawl"
  | "camofox"
  | "mock"
  | "unconfigured";

export type BrowserSessionStateReason =
  | "backend_available"
  | "session_missing"
  | "tab_missing"
  | "browser_process_missing";

export type BrowserCloudProviderKind =
  | "browserbase"
  | "browser-use"
  | "firecrawl"
  | "camofox"
  | (string & {});

export type BrowserSession = {
  id: string;
  backend: BrowserBackendKind;
  currentUrl?: string;
  createdAt: string;
};

export type WebExtractionResult = {
  url: string;
  title?: string;
  content: string;
  contentType?: string;
  status?: number;
  source: "fetch" | "browser" | "cache" | "mock";
};

export type BrowserReadiness = "loading" | "interactive" | "complete" | "unknown";

export type BrowserStateIdentity = {
  documentEpoch: number;
  actionRevision: number;
  observationId: number;
};

export type BrowserWaitCondition =
  | { kind: "url"; contains: string }
  | { kind: "text"; value: string }
  | { kind: "element"; role?: string; name?: string }
  | { kind: "dialog" }
  | { kind: "dom-stable" };

export type BrowserLocator = {
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  withinText?: string;
  exact?: boolean;
  identity?: BrowserStateIdentity;
};

export type BrowserLocatorCandidate = {
  ref: string;
  identity: BrowserStateIdentity;
  tabRef: string;
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  withinText?: string;
  /** Smallest meaningful runtime-observed container shared with related actions. */
  regionText?: string;
};

export type BrowserFindResult = {
  sessionId: string;
  identity: BrowserStateIdentity;
  tabRef: string;
  status: "found" | "ambiguous" | "not-found";
  candidates: BrowserLocatorCandidate[];
  /** Structurally grounded current-document candidates; never treated as exact matches. */
  nearbyCandidates?: BrowserLocatorCandidate[];
};

export type BrowserActionPreflightKind = "click" | "press" | "dialog";

export type BrowserActionTargetKind =
  | "link"
  | "button"
  | "form-control"
  | "scripted-control"
  | "dialog"
  | "other";

/** Runtime-observed structural metadata. Page-provided text is bounded and redacted. */
export type BrowserActionTargetSemantics = {
  ref?: string;
  kind: BrowserActionTargetKind;
  tag?: string;
  role?: string;
  label?: string;
  href?: string;
  formAssociated: boolean;
  submit: boolean;
};

export type BrowserActionPreflight = {
  action: BrowserActionPreflightKind;
  sessionId: string;
  identity: BrowserStateIdentity;
  tabRef: string;
  url: string;
  target?: BrowserActionTargetSemantics;
};

export type BrowserExtractResult = {
  sessionId: string;
  identity: BrowserStateIdentity;
  tabRef: string;
  target: BrowserLocatorCandidate;
  text?: string;
  value?: string;
};

export type BrowserActionDeltaElement = {
  role?: string;
  name?: string;
};

type BrowserActionDeltaBase = {
  beforeIdentity?: BrowserStateIdentity;
  afterIdentity: BrowserStateIdentity;
  waitCondition: BrowserWaitCondition["kind"];
  conditionMet: boolean;
  url: {
    changed: boolean;
    before?: string;
    after: string;
  };
  addedElements?: BrowserActionDeltaElement[];
  removedElements?: BrowserActionDeltaElement[];
  openedTabs?: Array<Pick<BrowserTab, "ref" | "url" | "title">>;
  tabTransition?: {
    source: Pick<BrowserTab, "ref" | "url" | "title">;
    destination: Pick<BrowserTab, "ref" | "url" | "title">;
  };
  target?: Pick<BrowserLocatorCandidate, "ref" | "role" | "name" | "label" | "withinText" | "regionText">;
};

export type BrowserActionDelta = BrowserActionDeltaBase & (
  | {
      outcome: "changed" | "no-change" | "timeout";
      actionDispatched?: never;
      settlementFailed?: never;
      documentChangeObserved?: never;
      stateObservation?: never;
    }
  | {
      outcome: "dispatched-unverified";
      /** The browser action was sent, but its requested post-action settlement could not be verified. */
      actionDispatched: true;
      settlementFailed: true;
      /** True only when a post-dispatch observation proves the document epoch advanced. */
      documentChangeObserved: boolean;
      /** Distinguishes a recovered post-dispatch observation from the last state seen before dispatch. */
      stateObservation: "post-dispatch" | "last-known";
    }
);

export type BrowserSnapshot = {
  sessionId: string;
  url: string;
  identity: BrowserStateIdentity;
  observedAt: string;
  readiness?: BrowserReadiness;
  /** Observation content is intentionally suppressed while protected entry is active. */
  sensitiveInputActive?: true;
  actionDelta?: BrowserActionDelta;
  title?: string;
  text?: string;
  tab?: BrowserTab;
  openedTabs?: BrowserTab[];
  elements?: Array<{
    ref: string;
    role?: string;
    name?: string;
    text?: string;
    label?: string;
    withinText?: string;
    /** Smallest meaningful runtime-observed container shared with related actions. */
    regionText?: string;
    /** Runtime-owned result from the shared browser interactability evaluator. */
    interactable?: boolean;
    interactabilityReason?: "detached" | "hidden" | "inert" | "disabled" | "modal-blocked";
    hidden?: boolean;
    value?: string;
    disabled?: boolean;
    checked?: boolean | "mixed";
  }>;
  pendingDialogs?: Array<{
    id: string;
    type: string;
    message: string;
    defaultPrompt?: string;
  }>;
  frameTree?: Array<{
    frameId: string;
    url: string;
    origin: string;
    parentFrameId?: string;
    isOopif: boolean;
  }>;
  consoleHistory?: Array<{
    level: string;
    text: string;
    timestamp?: string;
  }>;
};

export type BrowserTab = {
  ref: string;
  url: string;
  title?: string;
  controlled: boolean;
};

export type BrowserTabList = {
  sessionId: string;
  tabs: BrowserTab[];
  blockedCount: number;
};

export type BrowserStateProjection = {
  sessionStatus: "active" | "missing" | "unconfigured";
  sessionId?: string;
  controlledTab?: BrowserTab;
  tabs?: BrowserTab[];
  tabInventoryComplete?: boolean;
  identity?: BrowserStateIdentity;
  readiness?: BrowserReadiness;
  freshness: "current" | "stale";
  externalChangeDetected?: boolean;
  lastAction?: {
    tool: string;
    status: "succeeded" | "failed";
    changed: boolean;
  };
};

export type BrowserSwitchTabInput = {
  sessionId?: string;
  tabRef: string;
  waitFor?: BrowserWaitCondition;
  waitTimeoutMs?: number;
  signal?: AbortSignal;
};

export type BrowserSwitchTabResult = {
  tab: BrowserTab;
  snapshot: BrowserSnapshot;
};

export type BrowserActionInput = {
  sessionId?: string;
  full?: boolean;
  ref?: string;
  identity?: BrowserStateIdentity;
  tabRef?: string;
  locator?: BrowserLocator;
  /** Same-state control bound for immediate local submission after protected delivery. */
  submitRef?: string;
  text?: string;
  value?: string;
  key?: string;
  direction?: "up" | "down";
  amount?: number;
  clear?: boolean;
  method?: string;
  params?: Record<string, unknown>;
  action?: "accept" | "dismiss";
  promptText?: string;
  waitFor?: BrowserWaitCondition;
  waitTimeoutMs?: number;
  signal?: AbortSignal;
};

export type BrowserConsoleEntry = {
  level: string;
  text: string;
  timestamp?: string;
};

export type BrowserScreenshotResult = {
  mimeType: "image/png" | "image/jpeg";
  base64: string;
};

export type BrowserProtectedFieldVerificationPhase = "before-collection" | "before-delivery";

export type BrowserProtectedFieldVerification =
  | { status: "verified" }
  | {
      status: "rejected";
      reason:
        | "session-mismatch"
        | "tab-mismatch"
        | "origin-mismatch"
        | "frame-mismatch"
        | "field-missing"
        | "field-replaced"
        | "field-hidden"
        | "field-disabled"
        | "field-semantics-mismatch"
        | "field-ambiguous"
        | "request-not-active";
    };

export type BrowserProtectedFieldInput = {
  destination: import("./secure-input.js").BrowserFieldSecureInputDestination;
  kind: import("./secure-input.js").SecureInputKind;
  phase: BrowserProtectedFieldVerificationPhase;
  signal?: AbortSignal;
};

export type BrowserProtectedFieldDeliveryInput = {
  destination: import("./secure-input.js").BrowserFieldSecureInputDestination;
  kind: import("./secure-input.js").SecureInputKind;
  value: Uint8Array;
  signal?: AbortSignal;
};

export type BrowserProtectedFieldDeliveryResult = {
  delivery: "delivered";
  submission: "not-requested" | "clicked" | "automatic" | "failed";
  documentChanged: boolean;
  challengeState: "departed" | "still-present" | "unknown";
  conditionMet: boolean;
  beforeIdentity: BrowserStateIdentity;
  afterIdentity: BrowserStateIdentity;
  sensitiveInputActive: boolean;
  snapshot: BrowserSnapshot;
};

export type BrowserProtectedSourceVerificationPhase = "before-authorization" | "before-delivery";

export type BrowserProtectedSourceVerification =
  | { status: "verified"; sourceLabel: string }
  | {
      status: "rejected";
      reason:
        | "session-mismatch"
        | "tab-mismatch"
        | "origin-mismatch"
        | "frame-mismatch"
        | "source-missing"
        | "source-replaced"
        | "source-hidden"
        | "source-empty"
        | "request-not-active";
    };

export type BrowserProtectedSourceInput = {
  source: import("./secure-input.js").BrowserFieldSecureInputSource;
  kind: import("./secure-input.js").SecureInputKind;
  phase: BrowserProtectedSourceVerificationPhase;
  signal?: AbortSignal;
};

export type BrowserProtectedSourceReadInput = {
  source: import("./secure-input.js").BrowserFieldSecureInputSource;
  kind: import("./secure-input.js").SecureInputKind;
  signal?: AbortSignal;
};

export type BrowserNavigateInput = {
  url: string;
  sessionId?: string;
  waitFor?: BrowserWaitCondition;
  waitTimeoutMs?: number;
  signal?: AbortSignal;
};

export type BrowserNavigateResult = {
  session: BrowserSession;
  snapshot: BrowserSnapshot;
  metadata?: Record<string, unknown>;
};

export type BrowserBackendStatus = {
  backend: BrowserBackendKind;
  available: boolean;
  endpoint?: string;
  reason?: string;
  version?: string;
  browser?: string;
  hybridRouting?: boolean;
  lastNavigationBackend?: BrowserBackendKind;
  lastRouteReason?: string;
  fallbackFromCloud?: boolean;
  fallbackProvider?: BrowserCloudProviderKind;
  fallbackReason?: string;
  sessionState?: BrowserSessionStateReason;
};

export type BrowserBackend = {
  kind: BrowserBackendKind;
  isAvailable(): Promise<boolean> | boolean;
  status(): Promise<BrowserBackendStatus> | BrowserBackendStatus;
  navigate(input: BrowserNavigateInput): Promise<BrowserNavigateResult>;
  snapshot?(input?: BrowserActionInput): Promise<BrowserSnapshot>;
  find?(input: BrowserActionInput): Promise<BrowserFindResult>;
  /** Resolves one exact structural target before policy assessment; execution consumes that binding. */
  preflightAction?(action: BrowserActionPreflightKind, input: BrowserActionInput): Promise<BrowserActionPreflight>;
  click?(input: BrowserActionInput): Promise<BrowserSnapshot>;
  type?(input: BrowserActionInput): Promise<BrowserSnapshot>;
  select?(input: BrowserActionInput): Promise<BrowserSnapshot>;
  extract?(input: BrowserActionInput): Promise<BrowserExtractResult>;
  scroll?(input: BrowserActionInput): Promise<BrowserSnapshot>;
  press?(input: BrowserActionInput): Promise<BrowserSnapshot>;
  back?(input?: BrowserActionInput): Promise<BrowserSnapshot>;
  getImages?(input?: BrowserActionInput): Promise<Array<{
    src: string;
    alt?: string;
  }>>;
  console?(input?: BrowserActionInput): Promise<BrowserConsoleEntry[]>;
  tabs?(input?: BrowserActionInput): Promise<BrowserTabList>;
  switchTab?(input: BrowserSwitchTabInput): Promise<BrowserSwitchTabResult>;
  cdp?(input: BrowserActionInput): Promise<unknown>;
  screenshot?(input?: BrowserActionInput): Promise<BrowserScreenshotResult>;
  /** Resolves a current semantic target to runtime-observed destination metadata. */
  prepareProtectedField?(input: BrowserActionInput): Promise<import("./secure-input.js").BrowserFieldSecureInputDestination>;
  /** Runtime-only protected field inspection. This is never registered as a model tool. */
  verifyProtectedField?(input: BrowserProtectedFieldInput): Promise<BrowserProtectedFieldVerification>;
  /** Runtime-only one-use delivery. The value must not be embedded in evaluated source. */
  deliverProtectedField?(input: BrowserProtectedFieldDeliveryInput): Promise<void>;
  /** Clears any values delivered by an incomplete grouped transaction before bindings are released. */
  abortProtectedFieldGroup?(destinations: readonly import("./secure-input.js").BrowserFieldSecureInputDestination[]): Promise<void>;
  /** Returns and clears the metadata-only settlement produced by the last protected delivery. */
  takeProtectedFieldDeliveryResult?(destination: import("./secure-input.js").BrowserFieldSecureInputDestination): BrowserProtectedFieldDeliveryResult | undefined;
  releaseProtectedField?(destination: import("./secure-input.js").BrowserFieldSecureInputDestination): Promise<void> | void;
  /** Binds and re-verifies an exact browser value without disclosing it to a model-visible surface. */
  verifyProtectedSource?(input: BrowserProtectedSourceInput): Promise<BrowserProtectedSourceVerification>;
  /** Reads a previously verified browser value into an ephemeral byte buffer. */
  readProtectedSource?(input: BrowserProtectedSourceReadInput): Promise<Uint8Array>;
  /** Releases runtime-only source bindings after every terminal transfer outcome. */
  releaseProtectedSource?(source: import("./secure-input.js").BrowserFieldSecureInputSource): Promise<void> | void;
  isSensitiveInputActive?(sessionId: string): boolean;
  dialog?(input?: BrowserActionInput): Promise<BrowserSnapshot>;
  closeSession?(sessionId: string): Promise<void> | void;
  close?(): Promise<void> | void;
};
