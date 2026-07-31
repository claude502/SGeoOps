"use client";

import { Building2, Plus, RefreshCw, X } from "lucide-react";
import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { buildCreateClientRequest } from "@/lib/organization/client-request";

type ClientSummary = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type ClientDraft = {
  name: string;
  slug: string;
  active: boolean;
};

type ClientPermissions = {
  canCreateClient: boolean;
};

const emptyDraft: ClientDraft = {
  name: "",
  slug: "",
  active: true,
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [permissions, setPermissions] = useState<ClientPermissions>({
    canCreateClient: false,
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<ClientDraft>(emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createDialogRef = useRef<HTMLDialogElement>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const loadClients = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch("/api/clients", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("CLIENT_LIST_FAILED");
      }
      const body = (await response.json()) as {
        clients: ClientSummary[];
        permissions: ClientPermissions;
      };
      setClients(body.clients);
      setPermissions(body.permissions);
    } catch {
      setPermissions({ canCreateClient: false });
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadClients();
  }, [loadClients]);

  async function createClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setCreateError(null);

    try {
      const response = await fetch(
        "/api/clients",
        buildCreateClientRequest(draft),
      );
      const body = (await response.json()) as {
        client?: ClientSummary;
        error?: string;
      };
      if (!response.ok || !body.client) {
        setCreateError(
          response.status === 409
            ? "A client with this slug already exists."
            : "Client creation failed.",
        );
        return;
      }

      setClients((current) =>
        [...current, body.client as ClientSummary].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      );
      setDraft(emptyDraft);
      createDialogRef.current?.close();
    } catch {
      setCreateError("Client creation failed.");
    } finally {
      setSubmitting(false);
    }
  }

  function openCreateDialog() {
    setCreateError(null);
    createDialogRef.current?.showModal();
    requestAnimationFrame(() => nameInputRef.current?.focus());
  }

  function closeCreateDialog() {
    createDialogRef.current?.close();
  }

  function restoreCreateTriggerFocus() {
    createTriggerRef.current?.focus();
  }

  return (
    <main className="clients-page">
      <header className="clients-header">
        <div>
          <p className="clients-eyebrow">Organization</p>
          <h1>Clients</h1>
        </div>
        <div className="clients-actions">
          <button
            aria-label="Refresh clients"
            className="icon-button"
            onClick={() => void loadClients()}
            title="Refresh clients"
            type="button"
          >
            <RefreshCw aria-hidden="true" size={17} />
          </button>
          {permissions.canCreateClient ? (
            <button
              className="button button-primary"
              onClick={openCreateDialog}
              ref={createTriggerRef}
              type="button"
            >
              <Plus aria-hidden="true" size={16} />
              New client
            </button>
          ) : null}
        </div>
      </header>

      <section aria-busy={loading} className="clients-table-shell">
        <div className="clients-table-head" role="row">
          <span>Client</span>
          <span>Status</span>
          <span>Updated</span>
        </div>

        {loading ? (
          <div className="clients-state">Loading clients...</div>
        ) : loadError ? (
          <div className="clients-state clients-state-error" role="alert">
            Client list unavailable.
          </div>
        ) : clients.length === 0 ? (
          <div className="clients-state">
            <Building2 aria-hidden="true" size={20} />
            No clients
          </div>
        ) : (
          <div className="clients-table-body">
            {clients.map((client) => (
              <div className="clients-table-row" key={client.id} role="row">
                <div>
                  <strong>{client.name}</strong>
                  <span>{client.slug}</span>
                </div>
                <span
                  className={
                    client.active
                      ? "client-status client-status-active"
                      : "client-status"
                  }
                >
                  {client.active ? "Active" : "Inactive"}
                </span>
                <time dateTime={client.updatedAt}>
                  {formatDate(client.updatedAt)}
                </time>
              </div>
            ))}
          </div>
        )}
      </section>

      {permissions.canCreateClient ? (
        <dialog
          aria-labelledby="new-client-title"
          className="client-modal"
          onClose={restoreCreateTriggerFocus}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeCreateDialog();
            }
          }}
          ref={createDialogRef}
        >
          <header className="client-modal-header">
            <h2 id="new-client-title">New client</h2>
            <button
              aria-label="Close"
              className="icon-button"
              onClick={closeCreateDialog}
              title="Close"
              type="button"
            >
              <X aria-hidden="true" size={17} />
            </button>
          </header>
          <form onSubmit={createClient}>
            <div className="client-form">
              <label>
                <span>Name</span>
                <input
                  autoFocus
                  autoComplete="organization"
                  maxLength={160}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  required
                  ref={nameInputRef}
                  value={draft.name}
                />
              </label>
              <label>
                <span>Slug</span>
                <input
                  autoComplete="off"
                  maxLength={100}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      slug: event.target.value,
                    }))
                  }
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  required
                  value={draft.slug}
                />
              </label>
              <label className="client-active-toggle">
                <input
                  checked={draft.active}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      active: event.target.checked,
                    }))
                  }
                  type="checkbox"
                />
                <span>Active</span>
              </label>
              {createError ? (
                <p className="client-form-error" role="alert">
                  {createError}
                </p>
              ) : null}
            </div>
            <footer className="modal-actions">
              <button
                className="button button-secondary"
                onClick={closeCreateDialog}
                type="button"
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={submitting}
                type="submit"
              >
                {submitting ? "Creating..." : "Create client"}
              </button>
            </footer>
          </form>
        </dialog>
      ) : null}
    </main>
  );
}
