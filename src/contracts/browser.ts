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
  revision?: number;
};

export type BrowserLocatorCandidate = {
  ref: string;
  revision: number;
  tabRef: string;
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  withinText?: string;
};

export type BrowserFindResult = {
  sessionId: string;
  revision: number;
  tabRef: string;
  status: "found" | "ambiguous" | "not-found";
  candidates: BrowserLocatorCandidate[];
};

export type BrowserExtractResult = {
  sessionId: string;
  revision: number;
  tabRef: string;
  target: BrowserLocatorCandidate;
  text?: string;
  value?: string;
};

export type BrowserActionDeltaElement = {
  role?: string;
  name?: string;
};

export type BrowserActionDelta = {
  outcome: "changed" | "no-change" | "timeout";
  beforeRevision: number;
  afterRevision: number;
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
};

export type BrowserSnapshot = {
  sessionId: string;
  url: string;
  revision: number;
  observedAt: string;
  readiness?: BrowserReadiness;
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
  revision?: number;
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
  revision?: number;
  tabRef?: string;
  locator?: BrowserLocator;
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
  dialog?(input?: BrowserActionInput): Promise<BrowserSnapshot>;
  closeSession?(sessionId: string): Promise<void> | void;
  close?(): Promise<void> | void;
};
