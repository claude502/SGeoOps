export type CreateClientRequestInput = {
  name: string;
  slug: string;
  active: boolean;
};

export function buildCreateClientRequest(input: CreateClientRequestInput) {
  return {
    method: "POST" as const,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  };
}
