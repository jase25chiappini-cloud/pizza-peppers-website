// src/lib/menuTransform.js
export function transformApiMenu(rawData) {
  if (!rawData || !Array.isArray(rawData.categories) || !Array.isArray(rawData.products)) {
    return { categories: [] };
  }

  const toTitle = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const toNumber = (val) =>
    typeof val === 'number' ? val : parseFloat(String(val).replace(/[^\d.]/g, ''));

  const categories = rawData.categories.map((category) => {
    const items = rawData.products
      .filter((p) => p.category_ref === category.ref)
      .map((product) => {
        const skus = Array.isArray(product.skus) ? product.skus : [];
        const sizeNames = skus.map((s) => toTitle(s.name || ''));
        const prices = skus.reduce((acc, sku) => {
          const key = toTitle(sku.name || 'Default');
          acc[key] = toNumber(sku.price);
          return acc;
        }, {});

        const hasMultiple = sizeNames.length > 1;
        const finalPrices = hasMultiple
          ? prices
          : { Default: prices.Default ?? toNumber(skus[0]?.price ?? 0) };

        return {
          name: product.name,
          description: product.description,
          sizes: hasMultiple ? sizeNames : null,
          prices: finalPrices,
          ingredients: product.ingredients || [],
          _id: product.id || product.product_id,
          _category_ref: product.category_ref,
          _skus: skus,
        };
      });

    return {
      name: category.name,
      items,
    };
  });

  return { categories };
}

