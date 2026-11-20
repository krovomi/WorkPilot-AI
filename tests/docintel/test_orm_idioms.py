"""The ORM read from the code, in every idiom each framework allows.

`test_docintel_code.py` reads one model per framework, written the way the
documentation writes it. This file reads the other spellings: each fluent
chain of EF Core, SQLAlchemy relationships without an annotation, Doctrine,
every association ActiveRecord and Eloquent offer, navigations that point
both ways, self or nowhere, irregular plurals, and the walk's own ceilings.
A reader that cannot read one idiom never costs the others.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from docintel import orm
from docintel.orm import _element, _norm, canonical, read_orm


def write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def relations(model) -> set[tuple[str, str, str]]:
    return {(r.kind, r.a, r.b) for r in model.relations}


class TestNames:
    @pytest.mark.parametrize(
        ("kind", "a", "b", "expected"),
        [
            ("N:1", "Order", "Customer", ("1:N", "Customer", "Order")),
            ("1:1", "User", "Profile", ("1:1", "Profile", "User")),
            ("N:N", "Tag", "Post", ("N:N", "Post", "Tag")),
            ("1:N", "Order", "Line", ("1:N", "Order", "Line")),
        ],
    )
    def test_a_relation_is_written_one_way(self, kind, a, b, expected):
        assert canonical(kind, a, b) == expected

    @pytest.mark.parametrize(
        ("word", "expected"),
        [
            ("Categories", "category"),
            ("addresses", "address"),
            ("boxes", "box"),
            ("status", "status"),
        ],
    )
    def test_irregular_plurals(self, word, expected):
        assert _norm(word) == expected

    def test_an_array_type_is_a_collection(self):
        assert _element("Acme.Order[]") == ("Order", True)

    def test_the_model_serialises(self, tmp_path):
        write(
            tmp_path,
            "db/schema.prisma",
            "model Post {\n  id Int @id\n}\n",
        )

        payload = json.loads(json.dumps(read_orm(tmp_path).to_dict()))

        assert payload["frameworks"] == ["prisma"]
        assert payload["entities"][0]["name"] == "Post"


EF_FLUENT = """public class ShopContext : DbContext
{
    public DbSet<Customer> Customers { get; set; }
    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Order>().HasOne<Customer>().WithMany();
        b.Entity<Customer>().HasMany(c => c.Addresses).WithOne();
        b.Entity<Tag>().HasMany(t => t.Posts).WithMany(p => p.Tags);
        b.Entity<Post>().HasMany(p => p.Comments);
        b.Entity<Comment>().HasOne(c => c.Author);
        b.Entity<Author>().HasMany();
        b.Entity<Address>().HasOne(a => a.Unknown);
    }
}
public class OtherContext : DbContext
{
    public DbSet<Customer> Customers { get; set; }
}
public class Customer { public List<Address> Addresses { get; set; } }
public class Address { public int Id { get; set; } }
public class Tag { public List<Post> Posts { get; set; } }
public class Post { public List<Tag> Tags { get; set; } public List<Comment> Comments { get; set; } }
public class Comment { public Author Author { get; set; } }
public class Author { public int Id { get; set; } }
public class Order { public int Id { get; set; } }
[Table("legacy")]
public class Legacy { }
"""


class TestEfCore:
    def test_every_fluent_chain(self, tmp_path):
        write(tmp_path, "src/ShopContext.cs", EF_FLUENT)

        model = read_orm(tmp_path)

        assert model.entities["Customer"].aliases == ["Customers"]
        assert "Legacy" not in model.entities
        assert {
            ("1:N", "Customer", "Order"),
            ("1:N", "Customer", "Address"),
            ("N:N", "Post", "Tag"),
            ("1:N", "Post", "Comment"),
            ("1:N", "Author", "Comment"),
        } <= relations(model)

    def test_a_chain_or_table_above_every_entity_has_no_owner(self, tmp_path):
        write(
            tmp_path,
            "src/Config.cs",
            'b.ToTable("stray"); b.HasOne<Order>().WithMany();\n'
            "public class C : IEntityTypeConfiguration<Order> { }\n"
            "public class Order { }\n",
        )

        model = read_orm(tmp_path)

        assert model.entities["Order"].table == "" and model.relations == []

    def test_a_context_that_names_no_entity_reads_nothing(self, tmp_path):
        write(tmp_path, "src/Empty.cs", "public class Empty : DbContext { }\n")

        assert read_orm(tmp_path).frameworks == []


class TestPython:
    def test_relationships_spelled_without_an_annotation(self, tmp_path):
        write(
            tmp_path,
            "app/models.py",
            "from sqlalchemy.orm import relationship\n\n"
            "class Base(DeclarativeBase):\n    pass\n\n"
            "class User(Base):\n"
            '    __tablename__ = "users"\n'
            '    profile = relationship("Profile", uselist=False)\n'
            '    groups = relationship("Group", secondary="memberships")\n'
            '    posts = relationship("Post")\n'
            '    odd = relationship(back_populates="user")\n\n'
            "class Profile(Base):\n    __tablename__ = 'profiles'\n\n"
            "class Group(Base):\n    __tablename__ = 'groups'\n\n"
            "class Post(Base):\n    __tablename__ = 'posts'\n",
        )

        model = read_orm(tmp_path)

        assert "Base" not in model.entities
        assert relations(model) == {
            ("1:1", "Profile", "User"),
            ("N:N", "Group", "User"),
        }

    def test_a_django_model_that_points_at_itself(self, tmp_path):
        write(
            tmp_path,
            "shop/models.py",
            "from django.db import models\n\n"
            "class Category(models.Model):\n"
            "    parent = models.ForeignKey('self', on_delete=models.CASCADE)\n",
        )

        [rel] = read_orm(tmp_path).relations

        assert (rel.kind, rel.a, rel.b) == ("1:N", "Category", "Category")

    def test_foreign_keys_to_no_table_or_already_related_add_nothing(self, tmp_path):
        write(
            tmp_path,
            "app/models.py",
            "class Customer(Base):\n"
            '    __tablename__ = "customers"\n'
            '    parent_id = mapped_column(ForeignKey("customers.id"))\n'
            '    audit_id = mapped_column(ForeignKey("audits.id"))\n\n'
            "class Order(Base):\n"
            '    __tablename__ = "orders"\n'
            '    customer_id = mapped_column(ForeignKey("customers.id"))\n'
            '    buyer = relationship("Customer", uselist=False)\n',
        )

        assert relations(read_orm(tmp_path)) == {("1:1", "Customer", "Order")}


class TestDecorated:
    def test_doctrine_attributes_and_annotations(self, tmp_path):
        write(
            tmp_path,
            "src/Entity/Order.php",
            "<?php\nuse Doctrine\\ORM\\Mapping as ORM;\n\n"
            "#[ORM\\Entity]\n#[ORM\\Table(name: 'orders')]\nclass Order\n{\n"
            "    #[ORM\\ManyToOne(targetEntity: Customer::class)]\n"
            "    private Customer $customer;\n"
            "    #[ORM\\OneToOne(inversedBy: 'order')]\n"
            "    private Invoice $invoice;\n}\n",
        )
        write(
            tmp_path,
            "src/Entity/Customer.php",
            "<?php\n/**\n * @ORM\\Entity\n */\nclass Customer\n{\n"
            '    /** @ORM\\ManyToMany(targetEntity="App\\Entity\\Tag") */\n'
            "    private $tags;\n}\n",
        )
        write(
            tmp_path,
            "src/Entity/Tag.php",
            "<?php\n#[ORM\\Entity]\nclass Tag {}\n",
        )
        write(
            tmp_path,
            "src/Service/Notes.php",
            "<?php\n// The ORM keeps no Entity here.\n",
        )

        model = read_orm(tmp_path)

        assert model.frameworks == ["doctrine"]
        assert model.entities["Order"].table == "orders"
        assert relations(model) == {
            ("1:N", "Customer", "Order"),
            ("N:N", "Customer", "Tag"),
        }

    def test_jpa_one_to_one_many_to_many_and_strays(self, tmp_path):
        write(
            tmp_path,
            "src/main/java/acme/User.java",
            "// @ManyToOne Stray stray;\n"
            "@Entity\npublic class User {\n"
            "    @OneToOne\n    private Profile profile;\n"
            "    @ManyToMany(targetEntity = Role.class)\n    private Set roles;\n"
            "    @OneToMany\n    private Order... orders;\n}\n"
            "@Entity\npublic class Profile { }\n"
            "@Entity\npublic class Role { }\n",
        )
        write(
            tmp_path,
            "src/main/java/acme/Notes.java",
            "// mentions @Entity without one\n",
        )

        assert relations(read_orm(tmp_path)) == {
            ("1:1", "Profile", "User"),
            ("N:N", "Role", "User"),
        }

    def test_typeorm_strays_have_no_owner(self, tmp_path):
        write(
            tmp_path,
            "src/user.entity.ts",
            "// @ManyToMany(() => Role)\n"
            "@Entity()\nexport class User {\n  @ManyToMany(() => Role)\n  roles: Role[];\n}\n"
            "@Entity()\nexport class Role {}\n",
        )
        write(tmp_path, "src/notes.ts", "// @Entity is not used here\n")

        assert relations(read_orm(tmp_path)) == {("N:N", "Role", "User")}


class TestConventions:
    def test_every_activerecord_association(self, tmp_path):
        write(
            tmp_path,
            "app/models/user.rb",
            "class User < ApplicationRecord\n"
            "  has_one :profile\n"
            "  has_many :categories\n"
            "  has_many :groups, through: :memberships\n"
            "  has_and_belongs_to_many :roles\n"
            "  belongs_to :company, class_name: 'Org::Company'\n"
            "end\n",
        )
        for name in ("Profile", "Category", "Group", "Role", "Company"):
            write(
                tmp_path,
                f"app/models/{name.lower()}.rb",
                f"class {name} < ApplicationRecord\nend\n",
            )

        assert relations(read_orm(tmp_path)) == {
            ("1:1", "Profile", "User"),
            ("1:N", "User", "Category"),
            ("N:N", "Group", "User"),
            ("N:N", "Role", "User"),
            ("1:N", "Company", "User"),
        }

    def test_every_eloquent_relation(self, tmp_path):
        write(
            tmp_path,
            "app/Models/User.php",
            "<?php\nclass User extends Authenticatable\n{\n"
            "    public function posts() { return $this->hasMany(Post::class); }\n"
            "    public function phone() { return $this->hasOne(Phone::class); }\n"
            "    public function roles() { return $this->belongsToMany(Role::class); }\n"
            "}\n",
        )
        for name in ("Post", "Phone", "Role"):
            write(
                tmp_path,
                f"app/Models/{name}.php",
                f"<?php\nclass {name} extends Model {{}}\n",
            )

        assert relations(read_orm(tmp_path)) == {
            ("1:N", "User", "Post"),
            ("1:1", "Phone", "User"),
            ("N:N", "Role", "User"),
        }

    def test_a_go_struct_without_gorm_is_no_entity(self, tmp_path):
        write(
            tmp_path,
            "models.go",
            'package models\nimport "gorm.io/gorm"\n'
            "type Team struct {\n\tgorm.Model\n}\n"
            "type Options struct {\n\tVerbose bool\n}\n",
        )

        assert set(read_orm(tmp_path).entities) == {"Team"}


class TestNavigations:
    def test_each_pair_of_navigations_says_its_cardinality(self, tmp_path):
        write(
            tmp_path,
            "db/schema.prisma",
            'datasource db {\n  provider = "postgresql"\n}\n'
            "model Author {\n  id Int @id\n  blog Blog?\n}\n"
            "model Blog {\n  id Int @id\n  authors Author[]\n}\n"
            "model Profile {\n  id Int @id\n  user User\n}\n"
            "model User {\n  id Int @id\n  profile Profile?\n}\n"
            "model Comment {\n  id Int @id\n  post Post\n}\n"
            "model Post {\n  id Int @id\n  tags Tag[]\n}\n"
            "model Tag {\n  id Int @id\n  posts Post[]\n}\n"
            "model Category {\n  id Int @id\n  parent Category?\n}\n",
        )
        write(tmp_path, "db/empty.prisma", 'generator client {\n  provider = "x"\n}\n')

        assert relations(read_orm(tmp_path)) == {
            ("1:N", "Blog", "Author"),
            ("1:1", "Profile", "User"),
            ("1:N", "Post", "Comment"),
            ("N:N", "Post", "Tag"),
        }

    def test_an_explicit_relation_to_an_unmapped_class_is_dropped(self, tmp_path):
        write(
            tmp_path,
            "app/models/order.rb",
            "class Order < ApplicationRecord\n  belongs_to :warehouse\nend\n",
        )

        assert read_orm(tmp_path).relations == []


class TestTheWalk:
    def test_links_big_or_unreadable_files_and_the_ceilings(
        self, tmp_path, monkeypatch
    ):
        schema = "model A {\n  id Int @id\n}\n"
        write(tmp_path, "a.prisma", schema)
        write(tmp_path, "big.prisma", schema + " " * 256)
        locked = write(tmp_path, "locked.prisma", schema.replace("A", "L"))
        write(tmp_path, "z.prisma", schema.replace("A", "Z"))
        write(tmp_path, "deep/one/b.prisma", schema.replace("A", "B"))
        try:
            (tmp_path / "link.prisma").symlink_to(tmp_path / "a.prisma")
        except OSError:  # Windows without the right to make one
            pass
        monkeypatch.setattr(orm, "MAX_FILE_BYTES", len(schema) + 64)
        monkeypatch.setattr(orm, "MAX_DEPTH", 1)
        real = Path.read_text

        def read_text(self, *args, **kwargs):
            if self == locked:
                raise PermissionError(self)
            return real(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", read_text)

        assert set(read_orm(tmp_path).entities) == {"A", "Z"}
        monkeypatch.setattr(orm, "MAX_FILES", 1)
        assert set(read_orm(tmp_path).entities) == {"A"}

    def test_a_tree_that_cannot_be_walked_has_no_model(self, tmp_path, monkeypatch):
        def unreadable(_root):
            raise PermissionError("locked")

        monkeypatch.setattr(orm, "_sources", unreadable)

        assert read_orm(tmp_path).entities == {}

    def test_one_reader_that_fails_costs_only_its_idiom(self, tmp_path, monkeypatch):
        write(tmp_path, "db/schema.prisma", "model Post {\n  id Int @id\n}\n")

        def broken(_files, _builder):
            raise ValueError("misread")

        monkeypatch.setattr(orm, "_read_efcore", broken)

        assert set(read_orm(tmp_path).entities) == {"Post"}
