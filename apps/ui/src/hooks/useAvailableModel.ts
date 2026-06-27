import { useEffect, useState } from "react";

export function useAvailableModel(models: string[]) {
  const [model, setModel] = useState(models[0] ?? "");

  useEffect(() => {
    setModel((current) => {
      if (current && models.includes(current)) return current;
      return models[0] ?? "";
    });
  }, [models]);

  return { model, setModel };
}
