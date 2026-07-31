"use client";

import { Building2, Plus, RefreshCw, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";

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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<ClientDraft>(emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadClients = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch("/api/clients", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("CLIENT_LIST_FAILED");
      }
      const body = (await response.json()) as { clients: ClientSummary[] };
      setClients(body.clients);
    } catch {
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
      const response = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
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
      setCreateOpen(false);
    } catch {
      setCreateError("Client creation failed.");
    } finally {
      setSubmitting(false);
    }
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
          <button
            className="button button-primary"
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
            type="button"
          >
            <Plus aria-hidden="true" size={16} />
            New client
          </button>
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

      {createOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="new-client-title"
            aria-modal="true"
            className="modal-panel client-modal"
            role="dialog"
          >
            <header className="client-modal-header">
              <h2 id="new-client-title">New client</h2>
              <button
                aria-label="Close"
                className="icon-button"
                onClick={() => setCreateOpen(false)}
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
                    autoComplete="organization"
                    maxLength={160}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    required
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
                  onClick={() => setCreateOpen(false)}
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
          </section>
        </div>
      ) : null}
    </main>
  );
}
