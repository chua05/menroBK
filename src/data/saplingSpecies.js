const SAPLING_SPECIES = Object.freeze([
  { treeName: "Guyabano", scientificName: "Annona muricata" },
  { treeName: "Pili", scientificName: "Canarium ovatum" },
  { treeName: "Narra", scientificName: "Pterocarpus indicus" },
  { treeName: "Dancalan", scientificName: "Albizia procera" },
  { treeName: "Atis", scientificName: "Annona squamosa" },
  { treeName: "Langka", scientificName: "Artocarpus heterophyllus" },
  { treeName: "Mangga", scientificName: "Mangifera indica" },
  { treeName: "Santol", scientificName: "Sandoricum koetjape" },
  { treeName: "Rambutan", scientificName: "Nephelium lappaceum" },
  { treeName: "Lanzones", scientificName: "Lansium parasiticum" },
  { treeName: "Molave / Jamorawon", scientificName: "Vitex parviflora" },
  { treeName: "Balig-ang", scientificName: "Syzygium polycephaloides" },
  { treeName: "Niyog", scientificName: "Cocos nucifera" },
  { treeName: "Acacia", scientificName: null },
  { treeName: "Kamagong", scientificName: "Diospyros blancoi" },
  { treeName: "Aratiles", scientificName: "Muntingia calabura" },
  { treeName: "Makopa", scientificName: "Syzygium samarangense" },
  { treeName: "Mulberry", scientificName: "Morus alba" },
  { treeName: "Kalamansi", scientificName: "Citrus × microcarpa" },
  { treeName: "Atimoya", scientificName: "Annona × atemoya" },
  { treeName: "Lumban", scientificName: "Aleurites moluccanus" },
  { treeName: "Kape", scientificName: "Coffea spp." },
  { treeName: "Libas", scientificName: "Spondias pinnata" },
  { treeName: "Kasoy", scientificName: "Anacardium occidentale" },
  { treeName: "Sampalok", scientificName: "Tamarindus indica" },
  { treeName: "Golden Shower", scientificName: "Cassia fistula" },
  { treeName: "Palawan Cherry", scientificName: "Cassia nodosa" },
  { treeName: "Pomelo Davao", scientificName: "Citrus maxima" },
  { treeName: "Chico", scientificName: "Manilkara zapota" },
  { treeName: "Kalumpit / Calomagon", scientificName: "Terminalia microcarpa" },
  { treeName: "Ogob", scientificName: "Artocarpus camansi" },
  { treeName: "Fire Tree", scientificName: "Delonix regia" },
  { treeName: "Avocado", scientificName: "Persea americana" },
  { treeName: "Talisay", scientificName: "Terminalia catappa" },
  { treeName: "Kaimito", scientificName: "Chrysophyllum cainito" },
  { treeName: "Kastanyas", scientificName: "Artocarpus camansi" },
  { treeName: "Banaba", scientificName: "Lagerstroemia speciosa" },
  { treeName: "Cacao", scientificName: "Theobroma cacao" },
]);

const SPECIES_BY_NAME = new Map(
  SAPLING_SPECIES.map((species) => [species.treeName.toLowerCase(), species])
);

function findSaplingSpecies(treeName) {
  return SPECIES_BY_NAME.get(String(treeName || "").trim().toLowerCase()) || null;
}

module.exports = { SAPLING_SPECIES, findSaplingSpecies };
