import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check, ChevronDown, Cpu, RefreshCw } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import type { DaemonClient } from "@server/client/daemon-client";
import type {
  XcodexRuntimeCatalog,
  XcodexRuntimeModel,
  XcodexRuntimeProvider,
  XcodexRuntimeRoute,
  XcodexRuntimeSupplier,
} from "@server/shared/messages";

interface XcodexRuntimeSelectorProps {
  agentId: string;
  client: DaemonClient | null;
  displayModel: string;
  disabled?: boolean;
}

interface RuntimeDraft {
  providerId: string;
  supplierId: string;
  modelId: string | null;
  realProviderOverride: string | null;
}

const EMPTY_PROVIDERS: XcodexRuntimeProvider[] = [];
const EMPTY_SUPPLIERS: XcodexRuntimeSupplier[] = [];
const EMPTY_MODELS: XcodexRuntimeModel[] = [];

const styles = StyleSheet.create((theme) => ({
  trigger: {
    minHeight: 34,
    maxWidth: 260,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  triggerDisabled: {
    opacity: 0.55,
  },
  triggerText: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
  },
  option: {
    minHeight: 42,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  optionSelected: {
    borderColor: theme.colors.palette.blue[500],
    backgroundColor: theme.colors.surface2,
  },
  optionDisabled: {
    opacity: 0.45,
  },
  optionTextGroup: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  optionLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  optionMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  errorText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.sm,
  },
  actionRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  actionButton: {
    minHeight: 38,
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  actionButtonText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  ghostButton: {
    minHeight: 38,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
}));

function optionButtonStyle({ selected, disabled }: { selected: boolean; disabled?: boolean }) {
  return ({ pressed }: { pressed: boolean }) => [
    styles.option,
    selected && styles.optionSelected,
    (pressed || disabled) && styles.optionDisabled,
  ];
}

function triggerStyle(disabled: boolean) {
  return ({ pressed }: { pressed: boolean }) => [
    styles.trigger,
    pressed && styles.triggerPressed,
    disabled && styles.triggerDisabled,
  ];
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function initialDraft(catalog: XcodexRuntimeCatalog): RuntimeDraft | null {
  const route = catalog.route;
  const providerId = route?.providerId ?? catalog.providers[0]?.id;
  if (!providerId) return null;
  const provider = catalog.providers.find((item) => item.id === providerId);
  const supplierId =
    route?.supplierId ??
    provider?.defaultSupplierId ??
    catalog.suppliers.find((supplier) => supplier.configured !== false)?.id ??
    catalog.suppliers[0]?.id;
  if (!supplierId) return null;
  return {
    providerId,
    supplierId,
    modelId: route?.modelId ?? null,
    realProviderOverride: route?.realProviderOverride ?? null,
  };
}

function describeSupplier(supplier: XcodexRuntimeSupplier): string {
  return [supplier.endpointLabel, supplier.wireApi, supplier.capability]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" · ");
}

function describeModel(model: XcodexRuntimeModel): string {
  const parts = [
    model.contextWindow ? `${model.contextWindow.toLocaleString()} ctx` : null,
    ...(model.inputModalities ?? []),
  ];
  return parts.filter(Boolean).join(" · ");
}

function resolveSelectedModelLabel(models: XcodexRuntimeModel[], modelId?: string | null): string {
  return models.find((model) => model.id === modelId)?.label ?? modelId ?? "Default model";
}

function RuntimeOption({
  label,
  meta,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  meta?: string | null;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={optionButtonStyle({ selected, disabled })}
      accessibilityRole="button"
    >
      <View style={styles.optionTextGroup}>
        <Text style={styles.optionLabel} numberOfLines={1}>
          {label}
        </Text>
        {meta ? (
          <Text style={styles.optionMeta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {selected ? <Check size={16} color={theme.colors.palette.blue[500]} /> : null}
    </Pressable>
  );
}

function RuntimeProviderOption({
  provider,
  selected,
  onSelect,
}: {
  provider: XcodexRuntimeProvider;
  selected: boolean;
  onSelect: (provider: XcodexRuntimeProvider) => void;
}) {
  const handlePress = useCallback(() => onSelect(provider), [onSelect, provider]);
  return (
    <RuntimeOption
      label={provider.label}
      meta={provider.description ?? null}
      selected={selected}
      onPress={handlePress}
    />
  );
}

function RuntimeSupplierOption({
  supplier,
  selected,
  onSelect,
}: {
  supplier: XcodexRuntimeSupplier;
  selected: boolean;
  onSelect: (supplier: XcodexRuntimeSupplier) => void;
}) {
  const handlePress = useCallback(() => onSelect(supplier), [onSelect, supplier]);
  return (
    <RuntimeOption
      label={supplier.label}
      meta={describeSupplier(supplier)}
      selected={selected}
      disabled={supplier.configured === false}
      onPress={handlePress}
    />
  );
}

function DefaultModelOption({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  return (
    <RuntimeOption
      label="Default model"
      meta="Use the desktop provider default"
      selected={selected}
      onPress={onSelect}
    />
  );
}

function RuntimeModelOption({
  model,
  selected,
  onSelect,
}: {
  model: XcodexRuntimeModel;
  selected: boolean;
  onSelect: (modelId: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(model.id), [model.id, onSelect]);
  return (
    <RuntimeOption
      label={model.label}
      meta={model.disabledReason ?? describeModel(model)}
      selected={selected}
      disabled={Boolean(model.disabledReason)}
      onPress={handlePress}
    />
  );
}

function RuntimeSheetSubtitle({
  providerLabel,
  supplierLabel,
  modelLabel,
}: {
  providerLabel: string;
  supplierLabel: string;
  modelLabel: string;
}) {
  return (
    <Text style={styles.subtitle} numberOfLines={2}>
      {providerLabel} / {supplierLabel} / {modelLabel}
    </Text>
  );
}

function RuntimeRefreshButton({
  enabled,
  loading,
  saving,
  onPress,
}: {
  enabled: boolean;
  loading: boolean;
  saving: boolean;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  const disabled = loading || saving || !enabled;
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={styles.ghostButton}
      accessibilityRole="button"
      accessibilityLabel="Refresh runtime catalog"
    >
      {loading ? (
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      ) : (
        <RefreshCw size={16} color={theme.colors.foregroundMuted} />
      )}
    </Pressable>
  );
}

function RuntimeMessages({
  error,
  blockingReason,
}: {
  error: string | null;
  blockingReason: string | null;
}) {
  return (
    <>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {blockingReason ? <Text style={styles.errorText}>{blockingReason}</Text> : null}
    </>
  );
}

function RuntimeSections({
  catalog,
  draft,
  models,
  onSelectProvider,
  onSelectSupplier,
  onSelectDefaultModel,
  onSelectModel,
}: {
  catalog: XcodexRuntimeCatalog | null;
  draft: RuntimeDraft | null;
  models: XcodexRuntimeModel[];
  onSelectProvider: (provider: XcodexRuntimeProvider) => void;
  onSelectSupplier: (supplier: XcodexRuntimeSupplier) => void;
  onSelectDefaultModel: () => void;
  onSelectModel: (modelId: string) => void;
}) {
  const providers = catalog?.providers ?? EMPTY_PROVIDERS;
  const suppliers = catalog?.suppliers ?? EMPTY_SUPPLIERS;
  return (
    <>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Provider</Text>
        {providers.map((provider) => (
          <RuntimeProviderOption
            key={provider.id}
            provider={provider}
            selected={draft?.providerId === provider.id}
            onSelect={onSelectProvider}
          />
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Supplier</Text>
        {suppliers.map((supplier) => (
          <RuntimeSupplierOption
            key={supplier.id}
            supplier={supplier}
            selected={draft?.supplierId === supplier.id}
            onSelect={onSelectSupplier}
          />
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Model</Text>
        <DefaultModelOption selected={draft?.modelId == null} onSelect={onSelectDefaultModel} />
        {models.map((model) => (
          <RuntimeModelOption
            key={`${model.providerId}:${model.supplierId}:${model.id}`}
            model={model}
            selected={draft?.modelId === model.id}
            onSelect={onSelectModel}
          />
        ))}
      </View>
    </>
  );
}

function applyRuntimeRouteToCatalog(
  current: XcodexRuntimeCatalog | null,
  route: XcodexRuntimeRoute,
): XcodexRuntimeCatalog | null {
  return current ? { ...current, route } : current;
}

function applyRuntimeRouteToDraft(
  current: RuntimeDraft | null,
  route: XcodexRuntimeRoute,
): RuntimeDraft | null {
  if (!current) return current;
  return {
    ...current,
    providerId: route.providerId ?? current.providerId,
    supplierId: route.supplierId ?? current.supplierId,
    modelId: route.modelId ?? null,
    realProviderOverride: route.realProviderOverride ?? null,
  };
}

function useRuntimeCatalogState(agentId: string, client: DaemonClient | null, visible: boolean) {
  const [catalog, setCatalog] = useState<XcodexRuntimeCatalog | null>(null);
  const [draft, setDraft] = useState<RuntimeDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadCatalog = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const nextCatalog = await client.getXcodexRuntimeCatalog(agentId, { includeModels: true });
      setCatalog(nextCatalog);
      setDraft(initialDraft(nextCatalog));
    } catch (loadError) {
      setError(toErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [agentId, client]);

  useEffect(() => {
    if (!visible) return;
    void loadCatalog();
  }, [loadCatalog, visible]);

  useEffect(() => {
    if (!client) return;
    return client.on("xcodex_thread_runtime_update", (message) => {
      if (message.payload.agentId !== agentId) return;
      setCatalog((current) => applyRuntimeRouteToCatalog(current, message.payload.route));
      setDraft((current) => applyRuntimeRouteToDraft(current, message.payload.route));
    });
  }, [agentId, client]);

  return { catalog, setCatalog, draft, setDraft, error, setError, loading, loadCatalog };
}

function useRuntimeDerivedState(catalog: XcodexRuntimeCatalog | null, draft: RuntimeDraft | null) {
  const providerMap = useMemo(
    () => byId(catalog?.providers ?? EMPTY_PROVIDERS),
    [catalog?.providers],
  );
  const supplierMap = useMemo(
    () => byId(catalog?.suppliers ?? EMPTY_SUPPLIERS),
    [catalog?.suppliers],
  );
  const route = catalog?.route ?? null;
  const selectedProvider = draft ? providerMap.get(draft.providerId) : null;
  const selectedSupplier = draft ? supplierMap.get(draft.supplierId) : null;
  const modelsForDraft = useMemo(() => {
    if (!draft) return EMPTY_MODELS;
    return (catalog?.models ?? EMPTY_MODELS).filter(
      (model) => model.providerId === draft.providerId && model.supplierId === draft.supplierId,
    );
  }, [catalog?.models, draft]);
  const selectedModelLabel = resolveSelectedModelLabel(modelsForDraft, draft?.modelId);
  return { route, selectedProvider, selectedSupplier, modelsForDraft, selectedModelLabel };
}

function useRuntimeDraftActions({
  catalog,
  draft,
  selectedSupplier,
  setDraft,
}: {
  catalog: XcodexRuntimeCatalog | null;
  draft: RuntimeDraft | null;
  selectedSupplier: XcodexRuntimeSupplier | null | undefined;
  setDraft: Dispatch<SetStateAction<RuntimeDraft | null>>;
}) {
  const selectProvider = useCallback(
    (provider: XcodexRuntimeProvider) => {
      if (!catalog) return;
      const supplierId =
        provider.defaultSupplierId ??
        selectedSupplier?.id ??
        catalog.suppliers.find((supplier) => supplier.configured !== false)?.id ??
        catalog.suppliers[0]?.id;
      if (!supplierId) return;
      const runtimePairUnchanged =
        draft?.providerId === provider.id && draft.supplierId === supplierId;
      setDraft({
        providerId: provider.id,
        supplierId,
        modelId: null,
        realProviderOverride: runtimePairUnchanged ? draft.realProviderOverride : null,
      });
    },
    [catalog, draft, selectedSupplier?.id, setDraft],
  );

  const selectSupplier = useCallback(
    (supplier: XcodexRuntimeSupplier) => {
      if (!catalog || !draft) return;
      const runtimePairUnchanged = supplier.id === draft.supplierId;
      setDraft({
        ...draft,
        supplierId: supplier.id,
        modelId: null,
        realProviderOverride: runtimePairUnchanged ? draft.realProviderOverride : null,
      });
    },
    [catalog, draft, setDraft],
  );

  const selectDefaultModel = useCallback(() => {
    setDraft((current) => (current ? { ...current, modelId: null } : current));
  }, [setDraft]);

  const selectModel = useCallback(
    (modelId: string) => {
      setDraft((current) => (current ? { ...current, modelId } : current));
    },
    [setDraft],
  );

  return { selectProvider, selectSupplier, selectDefaultModel, selectModel };
}

function useRuntimeSave({
  agentId,
  client,
  draft,
  route,
  setCatalog,
  setError,
  setVisible,
}: {
  agentId: string;
  client: DaemonClient | null;
  draft: RuntimeDraft | null;
  route: XcodexRuntimeRoute | null | undefined;
  setCatalog: Dispatch<SetStateAction<XcodexRuntimeCatalog | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setVisible: Dispatch<SetStateAction<boolean>>;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const saveRuntime = useCallback(async () => {
    if (!client || !draft || !route) return;
    setSaving(true);
    setError(null);
    try {
      const result = await client.setXcodexThreadRuntime({
        agentId,
        providerId: draft.providerId,
        supplierId: draft.supplierId,
        modelId: draft.modelId,
        realProviderOverride: draft.realProviderOverride,
        expectedUpdatedAtMs: route.updatedAtMs,
      });
      const resultRoute = result.route;
      if (!resultRoute) {
        throw new Error("xCodex runtime switch did not return a route");
      }
      setCatalog((current) => applyRuntimeRouteToCatalog(current, resultRoute));
      setVisible(false);
    } catch (saveError) {
      const message = toErrorMessage(saveError);
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [agentId, client, draft, route, setCatalog, setError, setVisible, toast]);

  return { saving, saveRuntime };
}

function canSaveRuntime({
  client,
  draft,
  route,
  loading,
  saving,
  disabled,
}: {
  client: DaemonClient | null;
  draft: RuntimeDraft | null;
  route: XcodexRuntimeRoute | null | undefined;
  loading: boolean;
  saving: boolean;
  disabled: boolean;
}) {
  return (
    Boolean(client && draft && route?.canSwitchNow !== false) && !loading && !saving && !disabled
  );
}

export function XcodexRuntimeSelector({
  agentId,
  client,
  displayModel,
  disabled = false,
}: XcodexRuntimeSelectorProps) {
  const { theme } = useUnistyles();
  const [visible, setVisible] = useState(false);
  const { catalog, setCatalog, draft, setDraft, error, setError, loading, loadCatalog } =
    useRuntimeCatalogState(agentId, client, visible);
  const { route, selectedProvider, selectedSupplier, modelsForDraft, selectedModelLabel } =
    useRuntimeDerivedState(catalog, draft);
  const { selectProvider, selectSupplier, selectDefaultModel, selectModel } =
    useRuntimeDraftActions({ catalog, draft, selectedSupplier, setDraft });
  const { saving, saveRuntime } = useRuntimeSave({
    agentId,
    client,
    draft,
    route,
    setCatalog,
    setError,
    setVisible,
  });
  const canSave = canSaveRuntime({ client, draft, route, loading, saving, disabled });

  const openSheet = useCallback(() => {
    if (disabled || !client) return;
    setVisible(true);
  }, [client, disabled]);

  const closeSheet = useCallback(() => {
    setVisible(false);
  }, []);

  const triggerDisabled = disabled || !client;
  const sheetSubtitle = useMemo(
    () => (
      <RuntimeSheetSubtitle
        providerLabel={selectedProvider?.label ?? "Provider"}
        supplierLabel={selectedSupplier?.label ?? "Supplier"}
        modelLabel={selectedModelLabel}
      />
    ),
    [selectedModelLabel, selectedProvider?.label, selectedSupplier?.label],
  );
  const headerActions = useMemo(
    () => (
      <RuntimeRefreshButton
        enabled={Boolean(client)}
        loading={loading}
        saving={saving}
        onPress={loadCatalog}
      />
    ),
    [client, loadCatalog, loading, saving],
  );
  const applyButtonStyle = useMemo(
    () => [styles.actionButton, !canSave && styles.actionButtonDisabled],
    [canSave],
  );

  return (
    <>
      <Pressable
        disabled={triggerDisabled}
        onPress={openSheet}
        style={triggerStyle(triggerDisabled)}
        accessibilityRole="button"
        accessibilityLabel="xCodex runtime"
        testID="xcodex-runtime-selector"
      >
        <Cpu size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
        <Text style={styles.triggerText} numberOfLines={1}>
          {displayModel || "xCodex"}
        </Text>
        <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      </Pressable>

      <AdaptiveModalSheet
        title="xCodex Runtime"
        subtitle={sheetSubtitle}
        visible={visible}
        onClose={closeSheet}
        testID="xcodex-runtime-sheet"
        headerActions={headerActions}
      >
        <RuntimeMessages error={error} blockingReason={route?.blockingReason ?? null} />
        <RuntimeSections
          catalog={catalog}
          draft={draft}
          models={modelsForDraft}
          onSelectProvider={selectProvider}
          onSelectSupplier={selectSupplier}
          onSelectDefaultModel={selectDefaultModel}
          onSelectModel={selectModel}
        />

        <View style={styles.actionRow}>
          <Pressable
            disabled={!canSave}
            onPress={saveRuntime}
            style={applyButtonStyle}
            accessibilityRole="button"
            testID="xcodex-runtime-apply"
          >
            {saving ? (
              <ActivityIndicator size="small" color={theme.colors.accentForeground} />
            ) : (
              <Text style={styles.actionButtonText}>Apply</Text>
            )}
          </Pressable>
        </View>
      </AdaptiveModalSheet>
    </>
  );
}
