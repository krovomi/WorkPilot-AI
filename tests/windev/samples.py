"""Synthetic WinDev elements in the text format, modelled on real projects.

The shapes (header, ``info``, ``code : |1+`` blocks one space under their key,
base64 ``internal_properties``, 64-bit ``identifier`` and ``procedure_id``)
are the ones WinDev 25 to 28 write; the values are made up.
"""

from __future__ import annotations

from windev.files import TEXT_HEADER

HEADER = (
    TEXT_HEADER + "\n"
    "#Internal properties refer to the properties of controls in windows, reports, etc.\n"
)


def procedure_set(
    name: str = "COL_Clients",
    procedures: str | None = None,
    version: int = 27,
) -> str:
    """A procedure set (``.wdg``) with two procedures by default."""
    if procedures is None:
        procedures = PROCEDURE.format(
            name="CalculeRemise",
            pid="2193899737526465975",
            body=(
                "      PROCEDURE CalculeRemise(nMontant est un monétaire) : monétaire\n"
                "      SI nMontant <= 0 ALORS RENVOYER 0\n"
                "      RENVOYER nMontant * 0.1\n"
            ),
        ) + PROCEDURE.format(
            name="Arrondi",
            pid="2193899737526465976",
            body=(
                "      PROCEDURE Arrondi(n est un réel) : entier\n"
                "      RENVOYER Arrondi(n)\n"
            ),
        )
    return (
        HEADER + "info :\n"
        f" name : {name}\n"
        f" major_version : {version}\n"
        " minor_version : 0\n"
        " type : 7\n"
        ' description : ""\n'
        " subtype : 0\n"
        "procedure_set :\n"
        " identifier : 0x1e724aee00158928\n"
        " internal_properties : BgAAAAYAAAB2/vstTMCJbS/hlxjFxirSqKvCUuv8\n"
        " code_elements :\n"
        "  type_code : 31\n"
        "  p_codes : []\n"
        "  procedures :\n"
        f"{procedures}"
        "  procedure_templates : []\n"
        "  property_templates : []\n"
        " code_parameters :\n"
        "  internal_properties : BgAAAAYAAAA6ih3UbgNXHwTtiPSFUEj+\n"
        "  original_name : Procédures1\n"
    )


PROCEDURE = (
    "   -\n"
    "     name : {name}\n"
    "     procedure_id : {pid}\n"
    "     type_code : 15\n"
    "     code : |1-\n"
    "{body}"
    "     type : 458752\n"
)

WINDOW = (
    HEADER + "info :\n"
    " name : FEN_Clients\n"
    " major_version : 26\n"
    " minor_version : 0\n"
    " type : 2\n"
    ' description : ""\n'
    " subtype : 0\n"
    "window :\n"
    " name : FEN_Clients\n"
    " identifier : 0x24eb68a9014bb538\n"
    " internal_properties : BgAAAAYAAABYQb8VfAFYutVBHXpZR3zx\n"
    " controls :\n"
    "  -\n"
    "    name : BTN_Valider\n"
    "    identifier : 0x24f4cd010a153aed\n"
    "    internal_properties : BgAAAAYAAACwzbWS7TqtmQ22ck\n"
    "    type : 4\n"
    "    code_elements :\n"
    "     type_code : 4\n"
    "     p_codes :\n"
    "      -\n"
    "        code : |1+\n"
    "         Enregistre()\n"
    "         Ferme()\n"
    "         \n"
    "        type : 18\n"
    "  -\n"
    "    name : SAI_Nom\n"
    "    identifier : 0x24f4cd010a153aee\n"
    "    internal_properties : BgAAAAYAAACwzbWS7TqtmQ22cl\n"
    "    type : 2\n"
    " code_elements :\n"
    "  type_code : 1\n"
    "  p_codes :\n"
    "   -\n"
    "     code : |1-\n"
    "      PROCEDURE MaFenêtre()\n"
    "      gnCompteur est un entier\n"
    "   -\n"
    "     code : |1+\n"
    "      \n"
    "      SI gnCompteur > 0 ALORS\n"
    "      \tInitialise()\n"
    "      FIN\n"
    "     type : 34\n"
    "  procedures :\n"
    "   -\n"
    "     name : Enregistre\n"
    "     procedure_id : 1510002689021418520\n"
    "     type_code : 14\n"
    "     code : |1+\n"
    "      procédure Enregistre()\n"
    "      HAjoute(Client)\n"
    "     type : 458752\n"
    "resources :\n"
    " string_res :\n"
    "  identifier : 0x14eb689a00037a14\n"
    "  internal_properties : BgAAAAYAAAAnMYFQ1bL\n"
)


def project_file(
    configurations: tuple[str, ...] = ("Exécutable Windows 64 bits",),
) -> str:
    """A project file (``.wdp``) with the given generation configurations."""
    configs = "".join(
        "  -\n"
        f"    name : {name}\n"
        "    internal_properties : BgAAAAYAAABobNLubXQgcLnR\n"
        "    configuration_id : 7244069190823270432\n"
        "    type : 1\n"
        for name in configurations
    )
    return (
        HEADER + "info :\n"
        " name : Gestion\n"
        " major_version : 28\n"
        " minor_version : 0\n"
        " type : 4097\n"
        ' description : ""\n'
        " subtype : 0\n"
        "project :\n"
        " identifier : 0x0\n"
        " internal_properties : BgAAAAYAAACv5dUnqyCHUzUoiW9p\n"
        " configurations :\n"
        f"{configs}"
        " elements :\n"
        "  identifier : 0x44eb682a008cc678\n"
        "  elements :\n"
        "   -\n"
        "     name : COL_Clients\n"
        "     identifier : 0x44eb68bb009ffcb1\n"
        "     internal_properties : BgAAAAYAAABWXLFxrE\n"
        "     physical_name : .\\COL_Clients.wdg\n"
        "     type : 7\n"
    )


NATIVE = b"PCS\x00\x14\x00\x00\x00\x01\x10\x00\x00\x00\x00\x1c\x00\x01\x00\x0c\x04{\x1a"
