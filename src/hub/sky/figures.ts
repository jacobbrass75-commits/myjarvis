// Constellation stick figures and star names for the SKY mode, hand-encoded for this project (simplified
// western figures, the way most planispheres draw them; a figure is a choice of lines between named
// stars, not anyone's data). Stars are Bayer designations as the Yale Bright Star Catalogue writes
// them: "alp" .. "ome" plus an optional component digit ("alp2"), in the figure's own constellation or
// another one after a dot ("bet.Tau"). A bare letter without its digit means the brightest component.
//
// Syntax per constellation: chains "a-b-c" separated by spaces.

export const FIGURES: Record<string, { name: string; lines: string }> = {
  And: { name: "Andromeda", lines: "alp-del-bet-gam bet-mu-nu" },
  Aql: { name: "Aquila", lines: "gam-alp-bet alp-del-lam del-zet del-the" },
  Ari: { name: "Aries", lines: "alp-bet-gam" },
  Aur: { name: "Auriga", lines: "alp-bet-the-bet.Tau-iot-alp alp-eps" },
  Boo: { name: "Bootes", lines: "alp-eps-del-bet-gam-rho-alp alp-eta alp-zet" },
  Cnc: { name: "Cancer", lines: "iot-gam-del-bet del-alp" },
  CVn: { name: "Canes Venatici", lines: "alp-bet" },
  CMa: { name: "Canis Major", lines: "bet-alp-del-eps del-eta" },
  CMi: { name: "Canis Minor", lines: "alp-bet" },
  Cap: { name: "Capricornus", lines: "alp-bet-psi-ome-del-gam-the-alp" },
  Cas: { name: "Cassiopeia", lines: "eps-del-gam-alp-bet" },
  Cep: { name: "Cepheus", lines: "gam-bet-alp-zet-iot-gam" },
  Cet: { name: "Cetus", lines: "bet-eta-the-zet-tau-bet zet-del-gam-alp" },
  CrB: { name: "Corona Borealis", lines: "the-bet-alp-gam-del-eps-iot" },
  Crv: { name: "Corvus", lines: "gam-del-bet-eps-gam eps-alp" },
  Cru: { name: "Crux", lines: "alp-gam bet-del" },
  Cyg: { name: "Cygnus", lines: "alp-gam-eta-bet del-gam-eps" },
  Del: { name: "Delphinus", lines: "eps-bet-alp-gam-del-bet" },
  Dra: { name: "Draco", lines: "bet-gam-xi-nu-bet xi-del-zet-eta-the-iot-alp-kap-lam" },
  Gem: { name: "Gemini", lines: "alp-bet alp-tau-eps-mu-eta bet-del-zet-gam" },
  Her: { name: "Hercules", lines: "eps-zet-eta-pi-eps zet-bet-alp eps-del" },
  Leo: { name: "Leo", lines: "eps-mu-zet-gam-eta-alp-the-bet-del-gam del-the" },
  Lib: { name: "Libra", lines: "sig-alp-bet-gam" },
  Lyr: { name: "Lyra", lines: "alp-zet-bet-gam-del-zet" },
  Oph: { name: "Ophiuchus", lines: "alp-kap-del-eps-zet-eta-bet-alp" },
  Ori: { name: "Orion", lines: "lam-alp-zet-kap lam-gam-del-bet alp-gam zet-eps-del" },
  Peg: { name: "Pegasus", lines: "alp-bet-alp.And-gam-alp alp-zet-the-eps bet-eta" },
  Per: { name: "Perseus", lines: "gam-alp-del-eps-zet alp-kap-bet-rho" },
  Sgr: { name: "Sagittarius", lines: "gam-eps-del-gam del-lam-phi-del eps-zet-phi phi-sig-tau-zet" },
  Sco: { name: "Scorpius", lines: "bet-del-pi del-sig-alp-tau-eps-mu-zet-eta-the-iot-kap-lam" },
  Tau: { name: "Taurus", lines: "zet-alp-the-gam-del-eps-bet" },
  Tri: { name: "Triangulum", lines: "alp-bet-gam-alp" },
  UMa: { name: "Ursa Major", lines: "eta-zet-eps-del-alp-bet-gam-del" },
  UMi: { name: "Ursa Minor", lines: "alp-del-eps-zet-bet-gam-eta-zet" },
  Vir: { name: "Virgo", lines: "alp-gam-eta-bet gam-del-eps alp-zet-del" },
};

/** Common names (IAU WGSN) of the brighter stars, keyed by Bayer letter + constellation. */
export const STAR_NAMES: Record<string, string> = {
  "alp CMa": "Sirius", "alp Car": "Canopus", "alp Boo": "Arcturus", "alp Cen": "Rigil Kent", "alp Lyr": "Vega",
  "alp Aur": "Capella", "bet Ori": "Rigel", "alp CMi": "Procyon", "alp Eri": "Achernar", "alp Ori": "Betelgeuse",
  "bet Cen": "Hadar", "alp Aql": "Altair", "alp Cru": "Acrux", "alp Tau": "Aldebaran", "alp Sco": "Antares",
  "alp Vir": "Spica", "bet Gem": "Pollux", "alp PsA": "Fomalhaut", "alp Cyg": "Deneb", "bet Cru": "Mimosa",
  "alp Leo": "Regulus", "eps CMa": "Adhara", "alp Gem": "Castor", "lam Sco": "Shaula", "gam Ori": "Bellatrix",
  "bet Tau": "Elnath", "eps Ori": "Alnilam", "alp Gru": "Alnair", "zet Ori": "Alnitak", "eps UMa": "Alioth",
  "alp UMa": "Dubhe", "alp Per": "Mirfak", "eta UMa": "Alkaid", "del CMa": "Wezen", "eps Sgr": "Kaus Australis",
  "alp UMi": "Polaris", "bet CMa": "Mirzam", "alp Hya": "Alphard", "gam Leo": "Algieba", "alp Ari": "Hamal",
  "bet Per": "Algol", "zet UMa": "Mizar", "sig Sgr": "Nunki", "alp And": "Alpheratz", "bet And": "Mirach",
  "alp Oph": "Rasalhague", "bet UMi": "Kochab", "bet Cet": "Diphda", "bet Leo": "Denebola", "gam Cas": "Navi",
  "alp Cas": "Schedar", "bet Cas": "Caph", "gam And": "Almach", "eps Peg": "Enif", "alp Peg": "Markab",
  "bet Peg": "Scheat", "gam Cyg": "Sadr", "gam Dra": "Eltanin", "alp CrB": "Alphecca", "del Ori": "Mintaka",
  "kap Ori": "Saiph", "bet Cyg": "Albireo", "eta Tau": "Alcyone", "alp Cet": "Menkar", "alp Lib": "Zubenelgenubi",
  "alp Dra": "Thuban", "alp Her": "Rasalgethi", "bet Lib": "Zubeneschamali", "alp Cep": "Alderamin", "omi Cet": "Mira",
};
