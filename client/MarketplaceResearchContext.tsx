import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { productsResponseSchema, type Product } from "../shared/products";
import { marketplaceResponseSchema, type MarketplaceResponse } from "../shared/marketplace";
import { api, ApiFailure, errorMessage } from "./api";

type MarketplaceResearch = {
  products: Product[];
  product: Product | undefined;
  selectProduct: (id: string) => void;
  productsLoading: boolean;
  productsError: string;
  reloadProducts: () => void;
  data: MarketplaceResponse | null;
  loading: boolean;
  busy: boolean;
  error: string;
  reloadStatus: () => void;
  mutate: (path: string, body: object, method?: "POST" | "PATCH") => Promise<boolean>;
};
const MarketplaceContext = createContext<MarketplaceResearch | null>(null);

export function useMarketplaceResearch() { return useContext(MarketplaceContext); }

export function MarketplaceResearchProvider({ businessId, onSessionExpired, children }: {
  businessId: string; onSessionExpired: () => void; children: ReactNode;
}) {
  return <MarketplaceResearchState key={businessId} businessId={businessId} onSessionExpired={onSessionExpired}>{children}</MarketplaceResearchState>;
}

function MarketplaceResearchState({ businessId, onSessionExpired, children }: {
  businessId: string; onSessionExpired: () => void; children: ReactNode;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState("");
  const [productsLoading, setProductsLoading] = useState(!!businessId);
  const [productsError, setProductsError] = useState("");
  const [catalogueReload, setCatalogueReload] = useState(0);
  const [reload, setReload] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    productId: string; data: MarketplaceResponse | null; loading: boolean; busy: boolean; error: string;
  } | null>(null);
  const active = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const expired = useRef(onSessionExpired); expired.current = onSessionExpired;
  const product = products.find((item) => item.id === selected);
  const productId = product?.id ?? "";
  const endpoint = `/api/businesses/${businessId}/products/${productId}/marketplace`;
  useEffect(() => {
    if (!businessId) return;
    const controller = new AbortController();
    setProducts([]); setSelected(""); setProductsError(""); setProductsLoading(true);
    void api(`/api/businesses/${businessId}/products`, productsResponseSchema, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setProducts(result.products); setSelected(result.products[0]?.id ?? "");
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiFailure && failure.status === 401) expired.current();
      else setProductsError(errorMessage(failure));
    }).finally(() => { if (!controller.signal.aborted) setProductsLoading(false); });
    return () => controller.abort();
  }, [businessId, catalogueReload]);
  useEffect(() => {
    if (!productId) return;
    const controller = new AbortController(); active.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    setSnapshot((current) => ({
      productId, data: current?.productId === productId ? current.data : null,
      loading: true, busy: false, error: "",
    }));
    async function read() {
      const version = revision.current;
      try {
        const data = await api(endpoint, marketplaceResponseSchema, { signal: controller.signal });
        if (controller.signal.aborted || revision.current !== version) return;
        setSnapshot({ productId, data, loading: false, busy: false, error: "" });
        if (data.running) timer = setTimeout(() => { void read(); }, 1500);
      } catch (failure) {
        if (controller.signal.aborted || revision.current !== version) return;
        if (failure instanceof ApiFailure && failure.status === 401) expired.current();
        else setSnapshot((current) => ({ productId, data: current?.data ?? null, loading: false, busy: false, error: errorMessage(failure) }));
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint, productId, reload]);
  const current = snapshot?.productId === productId ? snapshot : null;
  async function mutate(path: string, body: object, method: "POST" | "PATCH" = "POST") {
    if (!productId || !current || current.loading || current.busy || current.data?.running || !active.current || active.current.signal.aborted) return false;
    const signal = active.current.signal;
    revision.current++;
    setSnapshot({ ...current, busy: true, error: "" });
    try {
      const data = await api(`${endpoint}${path}`, marketplaceResponseSchema, { method, signal, body: JSON.stringify(body) });
      if (signal.aborted) return false;
      setSnapshot({ productId, data, loading: false, busy: false, error: "" });
      setReload((value) => value + 1);
      return true;
    } catch (failure) {
      if (signal.aborted) return false;
      if (failure instanceof ApiFailure && failure.status === 401) expired.current();
      else setSnapshot({ ...current, busy: false, error: errorMessage(failure) });
      return false;
    }
  }
  return <MarketplaceContext.Provider value={{
    products, product, selectProduct: setSelected, productsLoading, productsError,
    reloadProducts: () => setCatalogueReload((value) => value + 1),
    data: current?.data ?? null, loading: !!productId && (!current || current.loading),
    busy: current?.busy ?? false, error: current?.error ?? "",
    reloadStatus: () => setReload((value) => value + 1), mutate,
  }}>{children}</MarketplaceContext.Provider>;
}
