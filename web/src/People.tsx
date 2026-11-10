import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { listPeople, type PersonIdentity } from "./api";

export function personDisplayName(account: string | undefined, people: readonly PersonIdentity[], fallback = "未指定"): string {
  if (!account) return fallback;
  return people.find((person) => person.username === account)?.display_name?.trim() || account;
}

const PeopleContext = createContext<readonly PersonIdentity[]>([]);

/** Public identity directory, available to members as well as administrators. */
export function PeopleProvider({ children, known = [] }: {
  children: ReactNode; known?: readonly PersonIdentity[];
}) {
  const [people, setPeople] = useState<PersonIdentity[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = () => { void listPeople().then((next) => {
      if (alive) setPeople(next);
    }).catch(() => { /* Keep known identities and account fallback. */ }); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { alive = false; window.removeEventListener("focus", refresh); };
  }, []);
  const directory = useMemo(() => {
    const merged = new Map<string, PersonIdentity>();
    for (const person of [...known, ...people]) {
      if (person.display_name?.trim() || !merged.has(person.username)) merged.set(person.username, person);
    }
    return [...merged.values()];
  }, [people, known]);
  return <PeopleContext.Provider value={directory}>{children}</PeopleContext.Provider>;
}

export function usePersonName() {
  const people = useContext(PeopleContext);
  return useMemo(() => (account?: string, fallback?: string) =>
    personDisplayName(account, people, fallback), [people]);
}

export function PersonName({ account, fallback }: { account?: string; fallback?: string }) {
  const nameOf = usePersonName();
  return <span title={account}>{nameOf(account, fallback)}</span>;
}
