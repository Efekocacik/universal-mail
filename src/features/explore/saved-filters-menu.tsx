"use client";

import { Bookmark, MapPin, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError, FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ApiError } from "@/lib/client/api";
import { useCategories } from "@/lib/client/queries";
import {
  savedFiltersApi,
  useSavedFilterMutation,
  useSavedFilters,
  type SavedFilterItem,
} from "@/lib/client/saved-filters";
import { t } from "@/lib/i18n";
import {
  fromSavedPayload,
  SAVED_FILTER_NAME_MAX,
  sameFilters,
  toSavedPayload,
} from "@/lib/leads/saved-filter-payload";
import { useExplore } from "./state";

const isExists = (e: unknown) => e instanceof ApiError && e.code === "SAVED_FILTER_EXISTS";

/** Ad sorulan pencere (kaydet ve yeniden adlandır). Aynı ad varsa "Üzerine yaz" önerilir (yalnızca kaydetmede). */
function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  initialName,
  showArea,
  submitLabel,
  onSubmit,
  allowOverwrite,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  initialName: string;
  showArea: boolean;
  submitLabel: string;
  onSubmit: (v: { name: string; includeArea: boolean; overwrite: boolean }) => Promise<void>;
  allowOverwrite: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [includeArea, setIncludeArea] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exists, setExists] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  const submit = async (overwrite: boolean) => {
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: trimmed, includeArea: showArea && includeArea, overwrite });
      onOpenChange(false);
    } catch (e) {
      if (isExists(e)) setExists(true);
      else setError((e as Error).message || t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,420px)]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(false);
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="saved-filter-name">{t("savedFilters.name")}</Label>
            <Input
              id="saved-filter-name"
              value={name}
              maxLength={SAVED_FILTER_NAME_MAX}
              autoFocus
              autoComplete="off"
              placeholder={t("savedFilters.name.placeholder")}
              aria-invalid={exists || !!error}
              aria-describedby={exists || error ? "saved-filter-name-error" : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setExists(false);
                setError(null);
              }}
            />
            {(exists || error) && (
              <FieldError id="saved-filter-name-error" role="alert">
                {exists ? t("savedFilters.exists") : error}
              </FieldError>
            )}
          </div>
          {showArea && (
            <div className="space-y-1">
              <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                <Checkbox
                  checked={includeArea}
                  onCheckedChange={(v) => setIncludeArea(v === true)}
                />
                {t("savedFilters.includeArea")}
              </label>
              <FieldHint className="pl-6">{t("savedFilters.includeArea.hint")}</FieldHint>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            {exists && allowOverwrite ? (
              <Button type="button" disabled={busy} onClick={() => void submit(true)}>
                {t("savedFilters.overwrite")}
              </Button>
            ) : (
              <Button type="submit" disabled={busy || !trimmed || exists}>
                {submitLabel}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Kayıtlı süzgeçler menüsü: listeler, uygular, yeniden adlandırır, siler ve şu anki süzgeci kaydeder. Uygulanan kayıtlı
 * süzgeç küçük bir etiketle gösterilir; süzgeçler sonradan değişirse "Değişti · Güncelle" ile kayda yazılır.
 */
export function SavedFiltersMenu() {
  const ex = useExplore();
  const list = useSavedFilters();
  const { data: categories } = useCategories();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<SavedFilterItem | null>(null);
  const [deleting, setDeleting] = useState<SavedFilterItem | null>(null);
  const create = useSavedFilterMutation(savedFiltersApi.create);
  const update = useSavedFilterMutation(
    (v: { id: number; patch: Parameters<typeof savedFiltersApi.update>[1] }) =>
      savedFiltersApi.update(v.id, v.patch),
  );
  const remove = useSavedFilterMutation(savedFiltersApi.remove);

  const canSave = ex.activeFilterCount > 0 || ex.onlyInView;
  const area = ex.onlyInView ? ex.viewBounds : null;
  const items = list.data ?? [];
  const active = ex.activeSaved;
  const activeItem = active ? items.find((i) => i.id === active.id) : undefined;
  const changed = active ? !sameFilters(active.snapshot, ex.filters) : false;

  const apply = (item: SavedFilterItem) => {
    const r = fromSavedPayload(item.payload, {
      knownCategories: categories?.map((c) => c.key),
      now: Date.now(),
    });
    if (!r) {
      toast.error(t("savedFilters.invalid"));
      return;
    }
    ex.applyFilters(r.filters, { bbox: r.bbox, sort: item.sort });
    ex.setActiveSaved({ id: item.id, name: item.name, snapshot: r.filters });
    void savedFiltersApi.use(item.id);
    if (r.dropped.length > 0) toast.info(t("savedFilters.partial"));
    setOpen(false);
  };

  const updateActive = async () => {
    if (!active) return;
    try {
      const keepArea = activeItem?.includeArea ? area : null;
      const r = await update.mutateAsync({
        id: active.id,
        patch: { payload: toSavedPayload(ex.filters, keepArea), sort: ex.sort },
      });
      ex.setActiveSaved({ id: r.item.id, name: r.item.name, snapshot: ex.filters });
      toast.success(t("savedFilters.updated", { name: r.item.name }));
    } catch (e) {
      toast.error((e as Error).message || t("common.error"));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {active && (
        <span
          className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-primary/40 bg-card pl-2.5 pr-1 text-[12px]"
          data-testid="active-saved-filter"
        >
          <Bookmark className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="max-w-40 truncate">
            {t("savedFilters.active", { name: active.name })}
          </span>
          {changed && (
            <button
              type="button"
              onClick={() => void updateActive()}
              disabled={update.isPending}
              aria-label={t("savedFilters.updateLabel", { name: active.name })}
              className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {t("savedFilters.update")}
            </button>
          )}
        </span>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" className="h-8 text-[12px]">
            <Bookmark aria-hidden /> {t("savedFilters.button")}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-2">
          <h3 className="px-2 pb-1 text-[12px] font-semibold text-muted-foreground">
            {t("savedFilters.title")}
          </h3>
          {list.isLoading ? (
            <div className="space-y-1.5 p-1">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : items.length === 0 ? (
            <p className="px-2 py-3 text-[13px] text-muted-foreground">{t("savedFilters.empty")}</p>
          ) : (
            <ul className="um-scroll max-h-72 overflow-y-auto" data-testid="saved-filter-list">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="group flex items-center gap-1 rounded-md hover:bg-accent"
                >
                  {item.invalid ? (
                    <div className="min-w-0 flex-1 px-2 py-1.5">
                      <p className="truncate text-[13px] text-muted-foreground line-through">
                        {item.name}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {t("savedFilters.invalid")}
                      </p>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => apply(item)}
                      aria-label={t("savedFilters.apply", { name: item.name })}
                      className="flex min-h-9 min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[13px]"
                    >
                      <span className="truncate">{item.name}</span>
                      {item.includeArea && (
                        <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
                          <MapPin className="size-3" aria-hidden /> {t("savedFilters.area")}
                        </span>
                      )}
                    </button>
                  )}
                  {!item.invalid && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        setRenaming(item);
                      }}
                      aria-label={t("savedFilters.renameLabel", { name: item.name })}
                      title={t("savedFilters.rename")}
                      className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setDeleting(item);
                    }}
                    aria-label={t("savedFilters.deleteLabel", { name: item.name })}
                    title={t("savedFilters.deleteLabel", { name: item.name })}
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1 border-t pt-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              disabled={!canSave}
              title={canSave ? undefined : t("savedFilters.save.disabled")}
              onClick={() => {
                setOpen(false);
                setSaving(true);
              }}
            >
              {t("savedFilters.save")}
            </Button>
            {!canSave && (
              <p className="px-3 pb-1 text-[11px] text-muted-foreground">
                {t("savedFilters.save.disabled")}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {saving && (
        <NameDialog
          open
          onOpenChange={(v) => !v && setSaving(false)}
          title={t("savedFilters.saveTitle")}
          description={t("savedFilters.saveBody")}
          initialName=""
          showArea={area !== null}
          submitLabel={t("common.save")}
          allowOverwrite
          onSubmit={async ({ name, includeArea, overwrite }) => {
            const r = await create.mutateAsync({
              name,
              payload: toSavedPayload(ex.filters, includeArea ? area : null),
              sort: ex.sort,
              overwrite: overwrite || undefined,
            });
            ex.setActiveSaved({ id: r.item.id, name: r.item.name, snapshot: ex.filters });
            toast.success(t("savedFilters.saved", { name: r.item.name }));
          }}
        />
      )}

      {renaming && (
        <NameDialog
          open
          onOpenChange={(v) => !v && setRenaming(null)}
          title={t("savedFilters.renameTitle")}
          initialName={renaming.name}
          showArea={false}
          submitLabel={t("common.save")}
          allowOverwrite={false}
          onSubmit={async ({ name }) => {
            const r = await update.mutateAsync({ id: renaming.id, patch: { name } });
            if (active?.id === r.item.id) ex.setActiveSaved({ ...active, name: r.item.name });
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(v) => !v && setDeleting(null)}
        tone="danger"
        title={t("savedFilters.deleteTitle", { name: deleting?.name ?? "" })}
        description={t("savedFilters.deleteBody")}
        confirmLabel={t("common.delete")}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            if (active?.id === deleting.id) ex.setActiveSaved(null);
            toast.success(t("savedFilters.deleted", { name: deleting.name }));
          } catch (e) {
            toast.error((e as Error).message || t("common.error"));
            throw e;
          }
        }}
      />
    </div>
  );
}
