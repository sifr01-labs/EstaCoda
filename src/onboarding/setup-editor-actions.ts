export type SetupEditorActionId =
  | "edit-primary-model-route"
  | "repair-primary-provider"
  | "edit-primary-credential-reference"
  | "store-provider-credential-reference"
  | "edit-fallback-model-route"
  | "edit-auxiliary-model-route"
  | "repair-missing-credential"
  | "edit-security-mode"
  | "edit-workflow-learning"
  | "repair-workspace-trust"
  | "review-optional-capabilities"
  | "configure-channels"
  | "configure-voice"
  | "configure-image-generation"
  | "configure-browser"
  | "run-readonly-verification"
  | "repair-broken-config"
  | "repair-state-directory"
  | "cancel-setup-editor";

export type SetupEditorPatchField =
  | "model.provider"
  | "model.id"
  | "model.fallbacks"
  | "providers.*.apiKeyEnv"
  | "provider.route"
  | "provider.credentialReference"
  | "auxiliaryModels.*"
  | "security.approvalMode"
  | "skills.autonomy"
  | "workspaceTrust"
  | "channels"
  | "voice"
  | "vision"
  | "browser";

export type SetupEditorActionEffect =
  | "draft-config-patch"
  | "draft-trust-repair"
  | "draft-state-repair"
  | "read-only-verification"
  | "diagnostic-only"
  | "exit";

export type SetupEditorActionDraft = {
  readonly kind: "setup-editor-action-draft";
  readonly id: SetupEditorActionId;
  readonly copyKey: `setupEditor.actions.${string}`;
  readonly sectionId:
    | "config-summary"
    | "model-route"
    | "credentials"
    | "security-mode"
    | "workflow-learning"
    | "workspace-trust"
    | "optional-capabilities"
    | "verification"
    | "exit"
    | "config-safety";
  readonly effect: SetupEditorActionEffect;
  readonly readOnly: boolean;
  readonly mutatesConfig: false;
  readonly requiresExplicitApply: boolean;
  readonly preservesUnrelatedConfig: true;
  readonly patch?: {
    readonly kind: "scoped-config-patch-intent";
    readonly fields: readonly SetupEditorPatchField[];
    readonly preserveUnrelatedConfig: true;
  };
  readonly credentialRefs?: readonly {
    readonly kind: "env";
    readonly name: string;
    readonly value: "not-included";
  }[];
  readonly reviewValues?: Record<string, string | readonly string[] | boolean | number | undefined>;
};

export function setupEditorAction(input: Omit<SetupEditorActionDraft, "kind" | "mutatesConfig" | "preservesUnrelatedConfig">): SetupEditorActionDraft {
  return {
    kind: "setup-editor-action-draft",
    mutatesConfig: false,
    preservesUnrelatedConfig: true,
    ...input,
  };
}

export function scopedPatch(fields: readonly SetupEditorPatchField[]): SetupEditorActionDraft["patch"] {
  return {
    kind: "scoped-config-patch-intent",
    fields,
    preserveUnrelatedConfig: true,
  };
}
