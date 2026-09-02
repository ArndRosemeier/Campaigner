import { useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CheckCircle2Icon, ImageIcon, KeyRoundIcon, XCircleIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { readSettings, saveSettings, updateSettings } from '@/db/settingsRepo';
import { DEFAULT_CHAT_MODEL, DEFAULT_EMBEDDING_MODEL } from '@/domain/settings';
import { DEFAULT_IMAGE_MODEL } from '@/domain/image';
import { toastError, toastSuccess } from '@/lib/toast';
import { listImageModels, listModels, listVisionChatModels } from '@/llm/openrouter';
import { ModelInput } from '@/features/settings/model-input';

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
      const message = error instanceof Error ? error.message : String(error);
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
          label="Default chat model"
          value={current.defaultChatModel}
          onChange={(value) => {
            void updateSettings({ defaultChatModel: value });
          }}
          placeholder={DEFAULT_CHAT_MODEL}
          canBrowse={current.openRouterApiKey !== '' || test.kind === 'ok'}
        />
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
            label="Image model"
            value={current.imageModel}
            onChange={(value) => {
              void updateSettings({ imageModel: value });
            }}
            placeholder={DEFAULT_IMAGE_MODEL}
            canBrowse={current.openRouterApiKey !== '' || test.kind === 'ok'}
            fetchOptions={listImageModels}
          />
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
