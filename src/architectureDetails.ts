/** Optional UI details are separate from the native renderer schema. */
export interface ArchitectureNode {
  id: string; name: string; summary: string; responsibility?: string;
  interfaces?: string; acceptance?: string; evidence?: string;
  relationships: string[];
}
const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 6000) : '';
export function architectureNodes(source: Record<string, unknown>, details: unknown): ArchitectureNode[] {
  if (source.diagram_type !== 'architecture' || !Array.isArray(source.components)) return [];
  const components = source.components.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object');
  const supplied = Array.isArray(details) ? details.filter((n): n is Record<string, unknown> => !!n && typeof n === 'object') : [];
  const names = new Map(components.map(c => [text(c.id), text(c.label)]));
  return components.map(c => {
    const id = text(c.id), d = supplied.find(n => n.id === id);
    const card = Array.isArray(source.cards) ? source.cards.find((v: any) => v?.title === c.label) : undefined;
    return {id, name:text(c.label), summary:text(c.sublabel),
      responsibility:text(d?.responsibility) || (Array.isArray(card?.items) ? card.items.filter((v:unknown)=>typeof v==='string').join('\n') : ''),
      interfaces:text(d?.interfaces), acceptance:text(d?.acceptance), evidence:text(d?.evidence),
      relationships:(Array.isArray(source.connections)?source.connections:[]).filter((e:any)=>e && (e.from===id || e.to===id))
        .map((e:any)=>`${names.get(e.from) || e.from} → ${names.get(e.to) || e.to}${text(e.label)?'：'+text(e.label):''}`),
    };
  });
}
