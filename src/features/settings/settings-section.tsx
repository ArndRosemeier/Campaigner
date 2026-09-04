import { useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CheckCircle2Icon, ImageIcon, KeyRoundIcon, XCircleIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { readSettings, saveSettings, updateSettings } from '@/db/settingsRepo';
import { errorMessage } from '@/lib/errors';
import { DEFAULT_CHAT_MODEL, DEFAULT_EMBEDDING_MODEL } from '@/domain/settings';
import { DEFAULT_IMAGE_MODEL } from '@/domain/image';
import { toastError, toastSuccess } from '@/lib/toast';
import { listImageModels, listModels, listVisionChatModels } from '@/llm/openrouter';
import { ModelInput } from '@/features/settings/model-input';
import { ReasoningEffortSelect } from '@/features/settings/reasoning-effort-select';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; models: number }
  | { kind: 'fail'; message: string };

/**
 * OpenRouter settings card (05-UI.md §Settings): API key + "Test key",
 * default chat/embedding models with a browsable model list, embeddings
 * toggle.
 */
export function SettingsSection(): JSX.Element {
  const settings = useLiveQuery(() => readSettings(), []);
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  const current = settings;
  if (current === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>OpenRouter</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  const keyValue = keyDraft ?? current.openRouterApiKey;

  const saveKey = async (): Promise<void> => {
    await saveSettings({ ...current, openRouterApiKey: keyValue.trim() });
    setKeyDraft(null);
    setTest({ kind: 'idle' });
  };

  const testKey = async (): Promise<void> => {
    const trimmed = keyValue.trim();
    if (trimmed === '') {
      setTest({ kind: 'fail', message: 'Enter an API key first' });
      return;
    }
    if (trimmed !== current.openRouterApiKey) {
      await saveSettings({ ...current, openRouterApiKey: trimmed });
      setKeyDraft(null);
    }
    setTest({ kind: 'testing' });
    try {
      const models = await listModels();
      setTest({ kind: 'ok', models: models.length });
      toastSuccess(`API key works — ${models.length} models available`);
    } catch (error) {
      const message = errorMessage(error);
      setTest({ kind: 'fail', message });
      toastError('API key test failed', error);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon aria-hidden className="size-4" />
          OpenRouter
        </CardTitle>
        <CardDescription>
          Campaigner calls OpenRouter with your own API key; it is stored only in this browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="api-key">API key</Label>
          <div className="flex gap-2">
            <Input
              id="api-key"
              type="password"
              autoComplete="off"
              value={keyValue}
              placeholder="sk-or-…"
              onChange={(event) => {
                setKeyDraft(event.target.value);
              }}
            />
            <Button variant="outline" onClick={() => void saveKey()} disabled={keyDraft === null}>
              Save
            </Button>
            <Button variant="outline" onClick={() => void testKey()} data-testid="test-key">
              Test key
            </Button>
          </div>
          {test.kind === 'testing' && <p className="text-xs text-muted-foreground">Testing…</p>}
          {test.kind === 'ok' && (
            <p className="flex items-center gap-1 text-xs text-emerald-500">
              <CheckCircle2Icon aria-hidden className="size-3.5" /> Key works — {test.models} models
              available
            </p>
          )}
          {test.kind === 'fail' && (
            <p className="flex items-center gap-1 text-xs text-destructive">
              <XCircleIcon aria-hidden className="size-3.5" /> {test.message}
            </p>
          )}
        </div>

        <ModelInput
          id="chat-model"
          label="First-try chat model"
          value={current.defaultChatModel}
          onChange={(value) => {
            void updateSettings({ defaultChatModel: value });
          }}
          placeholder={DEFAULT_CHAT_MODEL}
          canBrowse={current.openRouterApiKey !== '' || test.kind === 'ok'}
        />
        <p className="text-xs text-muted-foreground">
          The workhorse every run starts on — a cheaper model is fine here.
        </p>
        <ModelInput
          id="fallback-chat-model"
          label="Fallback chat model"
          value={current.fallbackChatModel}
          onChange={(value) => {
            void updateSettings({ fallbackChatModel: value });
          }}
          placeholder=""
          canBrowse={current.openRouterApiKey !== '' || test.kind === 'ok'}
        />
        <p className="text-xs text-muted-foreground">
          The escalation tier, used only when the first-try model is congested, refuses the
          content, or fails its output contract (one repair attempt). Pick one at least as capable
          as the first-try model. Empty = no fallback — failures stay loud.
        </p>
        <ReasoningEffortSelect
          id="chat-reasoning-effort"
          label="Default reasoning effort"
          value={current.defaultReasoningEffort}
          model={current.defaultChatModel}
          canBrowse={current.openRouterApiKey !== '' || test.kind === 'ok'}
          onChange={(value) => {
            void updateSettings({ defaultReasoningEffort: value });
          }}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="parallel-requests">Parallel requests</Label>
          <Select
            value={String(current.maxParallelRequests)}
            items={Object.fromEntries(
              [1, 2, 3, 4].map((n) => [String(n), n === 1 ? '1 — sequential' : String(n)]),
            )}
            onValueChange={(val) => {
              if (val !== null) void updateSettings({ maxParallelRequests: Number(val) });
            }}
          >
            <SelectTrigger id="parallel-requests" className="w-full" data-testid="parallel-requests">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  <span>{n === 1 ? '1 — sequential' : String(n)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            How many OpenRouter requests may run at once when independent things are generated
            (entity batches, queued entity images, map candidates). Dependent chains — module
            parts, persona pipelines — always stay sequential. Higher is faster; paid models take
            this fine, free models cap at 20 requests/minute.
          </p>
        </div>
        <ModelInput
          id="embedding-model"
          label="Embedding model"
          value={current.embeddingModel}
          onChange={(value) => {
            void updateSettings({ embeddingModel: value });
          }}
          placeholder={DEFAULT_EMBEDDING_MODEL}
          canBrowse={current.openRouterApiKey !== '' || test.kind === 'ok'}
        />

        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label htmlFor="embeddings-enabled">Semantic search (embeddings)</Label>
            <p className="text-xs text-muted-foreground">
              Embeds chunks on demand via OpenRouter; keyword search works without it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!current.embeddingsEnabled && current.openRouterApiKey === '' && (
              <Badge variant="outline">needs key</Badge>
            )}
            <Switch
              id="embeddings-enabled"
              checked={current.embeddingsEnabled}
              onCheckedChange={(checked) => {
                void updateSettings({ embeddingsEnabled: checked });
              }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ImageIcon aria-hidden className="size-4" />
              <Label htmlFor="images-enabled">Image generation</Label>
            </div>
            <div className="flex items-center gap-2">
              {!current.imagesEnabled && current.openRouterApiKey === '' && (
                <Badge variant="outline">needs key</Badge>
              )}
              <Switch
                id="images-enabled"
                data-testid="images-enabled"
                checked={current.imagesEnabled}
                onCheckedChange={(checked) => {
                  void updateSettings({ imagesEnabled: checked });
                }}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Lets the Illustrator persona generate images (costs money per image). Images are stored
            locally in this browser.
          </p>
          <ModelInput
            id="image-model"
            label="First-try image model"
            value={current.imageModel}
            onChange={(value) => {
              void updateSettings({ imageModel: value });
            }}
            placeholder={DEFAULT_IMAGE_MODEL}
            canBrowse={current.openRouterApiKey !== '' || test.kind === 'ok'}
            fetchOptions={listImageModels}
          />
          <ModelInput
            id="fallback-image-model"
            label="Fallback image model"
            value={current.fallbackImageModel}
            onChange={(value) => {
              void updateSettings({ fallbackImageModel: value });
            }}
            placeholder=""
            canBrowse={current.openRouterApiKey !== '' || test.kind === 'ok'}
            fetchOptions={listImageModels}
          />
          <p className="text-xs text-muted-foreground">
            The fallback image model runs only when the first-try model is congested or refuses —
            empty = no fallback. Structure-first edits (encounter maps) skip it unless it accepts
            image input.
          </p>
          <ModelInput
            id="encounter-verify-model"
            label="Encounter map verify model"
            value={current.encounterVerifyModel}
            onChange={(value) => {
              void updateSettings({ encounterVerifyModel: value });
            }}
            placeholder={current.defaultChatModel}
            canBrowse={current.openRouterApiKey !== '' || test.kind === 'ok'}
            fetchOptions={listVisionChatModels}
          />
          <p className="text-xs text-muted-foreground">
            The encounter's verify step sends the generated battlemap to a <em>chat</em> model to
            check it against the room layout — that model must accept image input. Empty = default
            chat model. The browse list only offers vision-capable models.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
