export type BrowserBackendKind =
  | "local-cdp"
  | "browserbase"
  | "firecrawl"
  | "camofox"
  | "mock"
  | "unconfigured";

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

export type BrowserSnapshot = {
  sessionId: string;
  url: string;
  title?: string;
  text?: string;
  elements?: Array<{
    ref: string;
    role?: string;
    name?: string;
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

export type BrowserActionInput = {
  sessionId?: string;
  full?: boolean;
  ref?: string;
  text?: string;
  key?: string;
  direction?: "up" | "down";
  amount?: number;
  clear?: boolean;
  method?: string;
  params?: Record<string, unknown>;
  action?: "accept" | "dismiss";
  promptText?: string;
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
  signal?: AbortSignal;
};

export type BrowserNavigateResult = {
  session: BrowserSession;
  snapshot: BrowserSnapshot;
};

export type BrowserBackendStatus = {
  backend: BrowserBackendKind;
  available: boolean;
  endpoint?: string;
  reason?: string;
  version?: string;
  browser?: string;
};

export type BrowserBackend = {
  kind: BrowserBackendKind;
  isAvailable(): Promise<boolean> | boolean;
  status(): Promise<BrowserBackendStatus> | BrowserBackendStatus;
  navigate(input: BrowserNavigateInput): Promise<BrowserNavigateResult>;
  snapshot?(input?: BrowserActionInput): Promise<BrowserSnapshot>;
  click?(input: BrowserActionInput): Promise<BrowserSnapshot>;
  type?(input: BrowserActionInput): Promise<BrowserSnapshot>;
  scroll?(input: BrowserActionInput): Promise<BrowserSnapshot>;
  press?(input: BrowserActionInput): Promise<BrowserSnapshot>;
  back?(input?: BrowserActionInput): Promise<BrowserSnapshot>;
  getImages?(input?: BrowserActionInput): Promise<Array<{
    src: string;
    alt?: string;
  }>>;
  console?(input?: BrowserActionInput): Promise<BrowserConsoleEntry[]>;
  cdp?(input: BrowserActionInput): Promise<unknown>;
  screenshot?(input?: BrowserActionInput): Promise<BrowserScreenshotResult>;
  dialog?(input?: BrowserActionInput): Promise<BrowserSnapshot>;
};
