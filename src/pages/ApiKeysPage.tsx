import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { IconEye, IconEyeOff, IconKey, IconTrash2 } from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { apiKeysApi } from '@/services/api';
import { useAuthStore, useNotificationStore } from '@/stores';
import styles from './ApiKeysPage.module.scss';

function maskKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}••••${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 4)}••••••${trimmed.slice(-4)}`;
}

export function ApiKeysPage() {
  const { i18n } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const { showNotification, showConfirmation } = useNotificationStore();

  const [keys, setKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [visibleRows, setVisibleRows] = useState<Record<number, boolean>>({});

  const loadKeys = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const list = await apiKeysApi.list();
      setKeys(list);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotification(`Failed to load API keys: ${message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [connectionStatus, showNotification]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  useHeaderRefresh(loadKeys, connectionStatus === 'connected');

  const appendKey = useCallback(async () => {
    const trimmed = newKey.trim();
    if (!trimmed) {
      showNotification('Enter an API key before saving.', 'warning');
      return;
    }

    if (keys.includes(trimmed)) {
      showNotification('This API key already exists.', 'warning');
      return;
    }

    setSaving(true);
    try {
      const next = [...keys, trimmed];
      await apiKeysApi.replace(next);
      setKeys(next);
      setNewKey('');
      showNotification('API key added.', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotification(`Failed to add API key: ${message}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [keys, newKey, showNotification]);

  const beginEdit = useCallback((index: number) => {
    setEditingIndex(index);
    setEditingValue(keys[index] ?? '');
  }, [keys]);

  const cancelEdit = useCallback(() => {
    setEditingIndex(null);
    setEditingValue('');
  }, []);

  const saveEdit = useCallback(async () => {
    if (editingIndex === null) {
      return;
    }

    const trimmed = editingValue.trim();
    if (!trimmed) {
      showNotification('API key value cannot be empty.', 'warning');
      return;
    }

    setSaving(true);
    try {
      await apiKeysApi.update(editingIndex, trimmed);
      setKeys((previous) => previous.map((item, index) => (index === editingIndex ? trimmed : item)));
      setEditingIndex(null);
      setEditingValue('');
      showNotification('API key updated.', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotification(`Failed to update API key: ${message}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [editingIndex, editingValue, showNotification]);

  const removeKey = useCallback((index: number) => {
    const value = keys[index];
    if (!value) {
      return;
    }

    showConfirmation({
      title: 'Delete API key',
      message: `Remove ${maskKey(value)} from the user key list?`,
      variant: 'danger',
      confirmText: 'Delete',
      onConfirm: async () => {
        setSaving(true);
        try {
          await apiKeysApi.delete(index);
          setKeys((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
          setVisibleRows((previous) => {
            const next: Record<number, boolean> = {};
            Object.entries(previous).forEach(([key, visible]) => {
              const numericKey = Number(key);
              if (numericKey < index) {
                next[numericKey] = visible;
              } else if (numericKey > index) {
                next[numericKey - 1] = visible;
              }
            });
            return next;
          });
          if (editingIndex === index) {
            cancelEdit();
          }
          showNotification('API key deleted.', 'success');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          showNotification(`Failed to delete API key: ${message}`, 'error');
        } finally {
          setSaving(false);
        }
      },
    });
  }, [cancelEdit, editingIndex, keys, showConfirmation, showNotification]);

  const toggleVisible = useCallback((index: number) => {
    setVisibleRows((previous) => ({
      ...previous,
      [index]: !previous[index],
    }));
  }, []);

  const activeKeyCountLabel = `${keys.length} key${keys.length === 1 ? '' : 's'} configured`;

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>User key management</span>
          <h1 className={styles.title}>API Keys</h1>
          <p className={styles.subtitle}>
            Create, review, update, and remove the user keys that feed the new usage dashboard.
          </p>
        </div>

        <div className={styles.heroMeta}>
          <div className={styles.heroPill}>
            <IconKey size={18} />
            <span>{activeKeyCountLabel}</span>
          </div>
          <Link to="/usage" className={styles.linkButton}>
            Open usage
          </Link>
        </div>
      </section>

      <Card className={styles.addCard}>
        <div className={styles.cardHeader}>
          <div>
            <h2>Add API key</h2>
            <p>New keys are appended to the current user-key list.</p>
          </div>
        </div>

        <div className={styles.addRow}>
          <Input
            value={newKey}
            onChange={(event) => setNewKey(event.target.value)}
            placeholder="sk-user-..."
            label="New key"
          />
          <Button onClick={() => void appendKey()} loading={saving}>
            Save key
          </Button>
        </div>
      </Card>

      <Card className={styles.listCard}>
        <div className={styles.cardHeader}>
          <div>
            <h2>Configured keys</h2>
            <p>Masked by default, with inline edit and delete actions.</p>
          </div>
          <span className={styles.metaText}>{loading ? 'Loading…' : activeKeyCountLabel}</span>
        </div>

        {loading ? (
          <div className={styles.loadingState}>
            <LoadingSpinner size={28} />
            <span>Loading API keys…</span>
          </div>
        ) : keys.length === 0 ? (
          <div className={styles.emptyState}>No user API keys are configured yet.</div>
        ) : (
          <div className={styles.keyList}>
            {keys.map((value, index) => {
              const isEditing = editingIndex === index;
              const isVisible = Boolean(visibleRows[index]);
              return (
                <div key={`${index}-${value}`} className={styles.keyRow}>
                  <div className={styles.keyInfo}>
                    <span className={styles.keyIndex}>#{index + 1}</span>
                    {isEditing ? (
                      <Input
                        value={editingValue}
                        onChange={(event) => setEditingValue(event.target.value)}
                        aria-label={`Edit API key ${index + 1}`}
                      />
                    ) : (
                      <code className={styles.keyValue}>{isVisible ? value : maskKey(value)}</code>
                    )}
                    <small className={styles.keyMeta}>
                      {isEditing
                        ? 'Editing this key'
                        : `Visible to you only · ${new Date().toLocaleDateString(i18n.language)}`}
                    </small>
                  </div>

                  <div className={styles.keyActions}>
                    {!isEditing ? (
                      <button
                        type="button"
                        className={styles.iconButton}
                        onClick={() => toggleVisible(index)}
                        aria-label={isVisible ? 'Hide key' : 'Show key'}
                      >
                        {isVisible ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                      </button>
                    ) : null}

                    {isEditing ? (
                      <>
                        <Button size="sm" variant="secondary" onClick={cancelEdit} disabled={saving}>
                          Cancel
                        </Button>
                        <Button size="sm" onClick={() => void saveEdit()} loading={saving}>
                          Save
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => beginEdit(index)} disabled={saving}>
                          Edit
                        </Button>
                        <button
                          type="button"
                          className={`${styles.iconButton} ${styles.iconButtonDanger}`}
                          onClick={() => removeKey(index)}
                          aria-label="Delete key"
                          disabled={saving}
                        >
                          <IconTrash2 size={16} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
